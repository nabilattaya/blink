const retryDelays = [
    30 * 1000,
    60 * 1000,
    2 * 60 * 1000,
    5 * 60 * 1000,
];

const defaultRequestTimeout = 30 * 1000;
const defaultMaxConcurrentRefreshes = 3;

class NativeRefreshHTTPError extends Error {
    constructor(widgetID, status) {
        super(`widget ${widgetID}: HTTP ${status}`);
        this.name = "NativeRefreshHTTPError";
        this.status = status;
    }
}

class NativeRefreshFragmentError extends Error {
    constructor(widgetID) {
        super(`widget ${widgetID}: invalid fragment`);
        this.name = "NativeRefreshFragmentError";
    }
}

function isPageStateStatus(status) {
    return status === 401 || status === 403 || status === 404;
}

function parseReplacement(widgetID, html) {
    const template = document.createElement("template");
    template.innerHTML = html.trim();

    const replacement = template.content.firstElementChild;

    if (
        replacement === null ||
        replacement.dataset.widgetId !== widgetID
    ) {
        throw new NativeRefreshFragmentError(widgetID);
    }

    return replacement;
}

export async function fetchNativeWidgetReplacement(
    widget,
    {
        baseURL,
        timeoutMs = defaultRequestTimeout,
        signal = null,
    }
) {
    const widgetID = widget.dataset.widgetId;

    if (widgetID === undefined) {
        return null;
    }

    const controller = new AbortController();
    let didTimeout = false;

    const forwardAbort = () => controller.abort(signal.reason);
    if (signal !== null) {
        if (signal.aborted) {
            controller.abort(signal.reason);
        } else {
            signal.addEventListener("abort", forwardAbort, { once: true });
        }
    }

    const timeout = setTimeout(() => {
        didTimeout = true;
        controller.abort(new DOMException("Widget refresh timed out", "TimeoutError"));
    }, timeoutMs);

    try {
        const response = await fetch(
            `${baseURL}/api/widgets/${widgetID}/content/`,
            { signal: controller.signal }
        );

        if (!response.ok) {
            throw new NativeRefreshHTTPError(widgetID, response.status);
        }

        const html = await response.text();
        return parseReplacement(widgetID, html);
    } catch (error) {
        if (didTimeout && error.name === "AbortError") {
            throw new DOMException("Widget refresh timed out", "TimeoutError");
        }

        throw error;
    } finally {
        clearTimeout(timeout);
        if (signal !== null) {
            signal.removeEventListener("abort", forwardAbort);
        }
    }
}

export function setupNativeWidgetRefresh({
    baseURL,
    initializeContent,
    cleanupContent,
    requestTimeoutMs = defaultRequestTimeout,
    maxConcurrentRefreshes = defaultMaxConcurrentRefreshes,
}) {
    const states = new Map();
    const pending = [];
    let activeRefreshes = 0;
    let reloading = false;

    const schedule = (state, delay) => {
        clearTimeout(state.timer);
        state.timer = null;

        if (document.hidden || reloading) {
            return;
        }

        state.timer = setTimeout(
            () => enqueue(state),
            Math.max(0, delay)
        );
    };

    const abortState = (state, reason) => {
        if (state.controller === null) {
            return;
        }

        state.abortReason = reason;
        state.controller.abort();
        state.controller = null;
    };

    const reloadPage = (status) => {
        if (reloading) {
            return;
        }

        reloading = true;

        for (const state of states.values()) {
            clearTimeout(state.timer);
            state.timer = null;
            abortState(state, "reload");
        }

        pending.length = 0;
        console.info(
            `Reloading page after native widget refresh returned HTTP ${status}`
        );
        window.location.reload();
    };

    const runRefresh = async (state) => {
        if (state.running || document.hidden || reloading) {
            return;
        }

        const widget = document.querySelector(
            `[data-widget-id="${state.id}"]`
        );

        if (widget === null) {
            states.delete(state.id);
            return;
        }

        state.running = true;
        state.abortReason = null;
        state.controller = new AbortController();

        let nextDelay = state.interval;

        try {
            const replacement = await fetchNativeWidgetReplacement(
                widget,
                {
                    baseURL,
                    timeoutMs: requestTimeoutMs,
                    signal: state.controller.signal,
                }
            );

            if (replacement === null || reloading) {
                return;
            }

            cleanupContent(widget);
            widget.replaceWith(replacement);
            await initializeContent(replacement);

            const interval = parseInt(
                replacement.dataset.widgetRefresh
            );

            if (
                Number.isFinite(interval) &&
                interval > 0
            ) {
                state.interval = interval;
            }

            state.lastRefresh = Date.now();
            state.failureCount = 0;
            nextDelay = state.interval;
        } catch (error) {
            if (
                error instanceof NativeRefreshHTTPError &&
                isPageStateStatus(error.status)
            ) {
                reloadPage(error.status);
                return;
            }

            if (
                error.name === "AbortError" &&
                (state.abortReason === "hidden" ||
                    state.abortReason === "reload")
            ) {
                return;
            }

            console.error(
                "Failed to refresh native widget:",
                error
            );

            if (state.failureCount < retryDelays.length) {
                nextDelay = Math.min(
                    retryDelays[state.failureCount],
                    state.interval
                );
            } else {
                nextDelay = state.interval;
            }

            state.failureCount++;
        } finally {
            state.running = false;
            state.controller = null;
            state.abortReason = null;

            if (states.has(state.id) && !reloading) {
                schedule(state, nextDelay);
            }
        }
    };

    const drain = () => {
        if (document.hidden || reloading) {
            return;
        }

        while (
            activeRefreshes < maxConcurrentRefreshes &&
            pending.length > 0
        ) {
            const state = pending.shift();
            state.queued = false;

            if (!states.has(state.id) || state.running) {
                continue;
            }

            activeRefreshes++;
            runRefresh(state).finally(() => {
                activeRefreshes--;
                drain();
            });
        }
    };

    const enqueue = (state) => {
        if (
            state.running ||
            state.queued ||
            document.hidden ||
            reloading ||
            !states.has(state.id)
        ) {
            return;
        }

        state.queued = true;
        pending.push(state);
        drain();
    };

    const discover = () => {
        const widgets = document.querySelectorAll(
            "[data-widget-id][data-widget-refresh]"
        );

        let index = 0;
        for (const widget of widgets) {
            const id = widget.dataset.widgetId;
            const interval = parseInt(
                widget.dataset.widgetRefresh
            );

            if (
                id === undefined ||
                !Number.isFinite(interval) ||
                interval <= 0 ||
                states.has(id)
            ) {
                continue;
            }

            const state = {
                id,
                interval,
                timer: null,
                running: false,
                queued: false,
                controller: null,
                abortReason: null,
                lastRefresh: Date.now(),
                failureCount: 0,
            };

            states.set(id, state);

            const staggerWindow = Math.min(
                2000,
                Math.floor(interval * 0.05)
            );
            const stagger = staggerWindow === 0
                ? 0
                : Math.floor(
                    (staggerWindow *
                        (index % maxConcurrentRefreshes)) /
                    maxConcurrentRefreshes
                );

            schedule(state, interval + stagger);
            index++;
        }
    };

    discover();

    if (states.size === 0) {
        return;
    }

    document.addEventListener(
        "visibilitychange",
        () => {
            const now = Date.now();

            if (document.hidden) {
                pending.length = 0;

                for (const state of states.values()) {
                    clearTimeout(state.timer);
                    state.timer = null;
                    state.queued = false;
                    abortState(state, "hidden");
                }

                return;
            }

            for (const state of states.values()) {
                const elapsed = now - state.lastRefresh;

                if (elapsed >= state.interval) {
                    enqueue(state);
                } else {
                    schedule(
                        state,
                        state.interval - elapsed
                    );
                }
            }
        }
    );
}
