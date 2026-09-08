import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, 'glance.yml');

async function waitForAllWidgetReplacements(page) {
    await page.evaluate(() => {
        window.__blinkOriginalRefreshWidgets = Array.from(
            document.querySelectorAll('[data-widget-refresh]')
        );
    });

    await expect.poll(
        () => page.evaluate(() =>
            window.__blinkOriginalRefreshWidgets.every(
                (element) => !element.isConnected
            )
        ),
        { timeout: 10_000 }
    ).toBe(true);
}

async function moduleURL(page, moduleName) {
    return page.evaluate((name) => {
        const script = Array.from(document.scripts).find(
            (element) => element.src.endsWith('/js/page.js')
        );
        if (script === undefined) {
            throw new Error('page.js module script not found');
        }
        return new URL(`./${name}`, script.src).href;
    }, moduleName);
}

test('interactive native widgets remain initialized after fragment replacement', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.clock [data-time]').first()).not.toHaveText('');
    await expect(page.getByTitle('Previous month')).toBeVisible();

    const todoInput = page.locator('.todo-input textarea');
    await todoInput.fill('persist across refresh');
    await todoInput.press('Enter');
    await expect(page.locator('.todo-item-text')).toHaveValue('persist across refresh');

    await waitForAllWidgetReplacements(page);

    await expect(page.locator('.clock [data-time]').first()).not.toHaveText('');
    await expect(page.getByTitle('Previous month')).toBeVisible();
    await expect(page.locator('.todo-item-text')).toHaveValue('persist across refresh');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('s');
    await expect(page.locator('.search-input')).toBeFocused();
});

test('refresh fetch validates fragments and times out stalled requests', async ({ page }) => {
    await page.goto('/');
    const nativeRefreshURL = await moduleURL(page, 'native-refresh.js');

    const result = await page.evaluate(async (url) => {
        const refresh = await import(url);
        const widget = document.createElement('div');
        widget.dataset.widgetId = '42';
        const originalFetch = window.fetch;

        try {
            window.fetch = async () => new Response(
                '<div data-widget-id="999"></div>',
                { status: 200 }
            );

            let invalidFragmentError;
            try {
                await refresh.fetchNativeWidgetReplacement(widget, {
                    baseURL: '',
                    timeoutMs: 250,
                });
            } catch (error) {
                invalidFragmentError = error.name;
            }

            window.fetch = (_url, options = {}) => new Promise((_, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });

            let timeoutError;
            try {
                await refresh.fetchNativeWidgetReplacement(widget, {
                    baseURL: '',
                    timeoutMs: 25,
                });
            } catch (error) {
                timeoutError = error.name;
            }

            return { invalidFragmentError, timeoutError };
        } finally {
            window.fetch = originalFetch;
        }
    }, nativeRefreshURL);

    expect(result.invalidFragmentError).toBe('NativeRefreshFragmentError');
    expect(result.timeoutError).toBe('TimeoutError');
});

test('popover setup and cleanup work on newly inserted subtrees', async ({ page }) => {
    await page.goto('/');
    const popoverURL = await moduleURL(page, 'popover.js');

    await page.evaluate(async (url) => {
        const popovers = await import(url);
        const root = document.createElement('div');
        root.id = 'popover-test-root';
        root.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;';
        root.innerHTML = '<button id="popover-test" data-popover-type="text" data-popover-text="Refreshed popover">Hover</button>';
        document.body.append(root);
        popovers.setupPopovers(root);
    }, popoverURL);

    await page.locator('#popover-test').hover();
    await expect(page.locator('.popover-content')).toHaveText('Refreshed popover');

    await page.evaluate(async (url) => {
        const popovers = await import(url);
        popovers.cleanupPopovers(document.getElementById('popover-test-root'));
    }, popoverURL);

    await expect(page.locator('.popover-container')).toBeHidden();
});

test('hidden pages pause refresh and resume when visible', async ({ page }) => {
    let refreshRequests = 0;
    page.on('request', (request) => {
        if (/\/api\/widgets\/\d+\/content\/$/.test(new URL(request.url()).pathname)) {
            refreshRequests++;
        }
    });

    await page.goto('/');
    await expect.poll(() => refreshRequests).toBeGreaterThan(0);

    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForTimeout(150);
    const hiddenRequestCount = refreshRequests;
    await page.waitForTimeout(1_300);
    expect(refreshRequests).toBe(hiddenRequestCount);

    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => false,
        });
        document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect.poll(() => refreshRequests).toBeGreaterThan(hiddenRequestCount);
});

test('refresh scheduler processes overdue widgets one request at a time', async ({ page }) => {
    let active = 0;
    let maximumActive = 0;
    let total = 0;

    await page.route('**/api/widgets/*/content/', async (route) => {
        active++;
        total++;
        maximumActive = Math.max(maximumActive, active);

        try {
            const response = await route.fetch();
            await new Promise((resolve) => setTimeout(resolve, 250));
            await route.fulfill({ response });
        } finally {
            active--;
        }
    });

    await page.goto('/');
    await expect.poll(() => total, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
    expect(maximumActive).toBe(1);
});

test('configuration hot reload recovers stale widget ids by reloading the page', async ({ page }) => {
    const originalConfig = await readFile(configPath, 'utf8');

    try {
        await page.goto('/');
        const originalWidgetID = await page.locator('[data-widget-refresh]').first().getAttribute('data-widget-id');

        await page.evaluate(() => {
            window.__blinkHotReloadSentinel = 'alive';
        });

        await writeFile(
            configPath,
            `${originalConfig}\n# browser hot reload test ${Date.now()}\n`,
            'utf8'
        );

        await expect.poll(
            () => page.evaluate(() => window.__blinkHotReloadSentinel),
            { timeout: 15_000 }
        ).toBeUndefined();

        const replacementWidgetID = await page.locator('[data-widget-refresh]').first().getAttribute('data-widget-id');
        expect(replacementWidgetID).not.toBe(originalWidgetID);
    } finally {
        await writeFile(configPath, originalConfig, 'utf8');
    }
});

test('only opted-in leaves refresh and group tabs survive child replacement', async ({ page }) => {
    const requested = new Set();
    page.on('request', (request) => {
        const match = new URL(request.url()).pathname.match(/\/api\/widgets\/(\d+)\/content\/$/);
        if (match) requested.add(match[1]);
    });
    await page.goto('/');
    await expect(page.locator('#not-refreshed')).toBeVisible();
    const expected = await page.locator('[data-widget-refresh]').evaluateAll(
        (widgets) => widgets.map((widget) => widget.dataset.widgetId)
    );
    await page.locator('.widget-group-title').nth(1).click();
    await page.evaluate(() => {
        window.__blinkNoReload = true;
        window.__blinkStaticWidget = document.getElementById('not-refreshed');
    });
    await waitForAllWidgetReplacements(page);
    await expect.poll(() => requested.size).toBe(expected.length);
    expect([...requested].sort()).toEqual(expected.sort());
    expect(await page.evaluate(() => window.__blinkNoReload && window.__blinkStaticWidget.isConnected)).toBe(true);
    await expect(page.locator('.widget-group-title').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.locator('.widget-group-title').first().click();
    await expect(page.locator('.widget-type-group .clock')).toBeVisible();
});

test('fragment replacement releases clock and calendar timers', async ({ page }) => {
    await page.addInitScript(() => {
        const set = window.setTimeout;
        const clear = window.clearTimeout;
        window.__blinkLongTimers = new Set();
        window.setTimeout = (callback, delay, ...args) => {
            const id = set(() => {
                window.__blinkLongTimers.delete(id);
                callback(...args);
            }, delay);
            if (delay > 10_000) window.__blinkLongTimers.add(id);
            return id;
        };
        window.clearTimeout = (id) => {
            window.__blinkLongTimers.delete(id);
            clear(id);
        };
    });
    await page.goto('/');
    await expect(page.getByTitle('Previous month')).toBeVisible();
    await page.evaluate(() => {
        window.__blinkOriginalTimers = [...window.__blinkLongTimers];
    });
    expect(await page.evaluate(() => window.__blinkOriginalTimers.length)).toBeGreaterThan(0);
    await waitForAllWidgetReplacements(page);
    expect(await page.evaluate(() => window.__blinkOriginalTimers.every(
        (id) => !window.__blinkLongTimers.has(id)
    ))).toBe(true);
    await expect(page.locator('.clock [data-time]').first()).not.toHaveText('');
    await expect(page.getByTitle('Previous month')).toBeVisible();
});

test('fragment layouts initialize locally and release observers and global listeners', async ({ page }) => {
    await page.addInitScript(() => {
        const OriginalObserver = window.ResizeObserver;
        window.__blinkObserved = new Map();
        window.ResizeObserver = class extends OriginalObserver {
            observe(target, options) {
                if (!window.__blinkObserved.has(this)) window.__blinkObserved.set(this, new Set());
                window.__blinkObserved.get(this).add(target);
                super.observe(target, options);
            }
            unobserve(target) {
                window.__blinkObserved.get(this)?.delete(target);
                super.unobserve(target);
            }
            disconnect() {
                window.__blinkObserved.delete(this);
                super.disconnect();
            }
        };
        const add = window.addEventListener;
        const remove = window.removeEventListener;
        window.__blinkResizeListeners = new Set();
        window.addEventListener = (type, listener, options) => {
            if (type === 'resize') window.__blinkResizeListeners.add(listener);
            add.call(window, type, listener, options);
        };
        window.removeEventListener = (type, listener, options) => {
            if (type === 'resize') window.__blinkResizeListeners.delete(listener);
            remove.call(window, type, listener, options);
        };
    });
    await page.goto('/lifecycle');
    await expect(page.locator('.masonry-column')).toHaveCount(2);
    const initialListeners = await page.evaluate(() => window.__blinkResizeListeners.size);
    for (let i = 0; i < 3; i++) {
        await waitForAllWidgetReplacements(page);
        await expect(page.locator('.masonry-column')).toHaveCount(2);
        await expect(page.locator('.expand-toggle-button')).toHaveCount(2);
        await expect(page.locator('.list .collapsible-item')).toHaveCount(2);
        await expect(page.locator('.cards-grid .collapsible-item')).toHaveCount(1);
        await expect(page.locator('.carousel-container')).toHaveClass(/show-right-cutoff/);
        await expect(page.locator('img[loading=lazy]')).toHaveClass(/finished-transition/);
        await expect(page.locator('.text-truncate')).toHaveAttribute('title', 'Refreshed title');
        await expect(page.locator('[data-dynamic-relative-time]')).not.toHaveText('');
        expect(await page.evaluate(() => window.__blinkResizeListeners.size)).toBe(initialListeners);
        expect(await page.evaluate(() => [...window.__blinkObserved.values()].every(
            (targets) => [...targets].every((target) => target.isConnected)
        ))).toBe(true);
    }
});

test('masonry setup is idempotent and cleanup disconnects removed content', async ({ page }) => {
    await page.goto('/lifecycle');
    await expect(page.locator('.masonry-column')).toHaveCount(2);
    const masonryURL = await moduleURL(page, 'masonry.js');
    const result = await page.evaluate(async (url) => {
        const masonry = await import(url);
        const root = document.querySelector('[data-widget-refresh]');
        masonry.setupMasonries(root);
        masonry.setupMasonries(root);
        const columns = root.querySelectorAll('.masonry-column').length;
        masonry.cleanupMasonries(root);
        root.remove();
        return columns;
    }, masonryURL);
    expect(result).toBe(2);
});

test('pending popovers cannot open after their target is removed', async ({ page }) => {
    await page.goto('/');
    const popoverURL = await moduleURL(page, 'popover.js');
    await page.evaluate(async (url) => {
        const popovers = await import(url);
        const root = document.createElement('div');
        root.innerHTML = '<button data-popover-type="text" data-popover-text="Removed target" data-popover-show-delay="100">Hover</button>';
        document.body.append(root);
        popovers.setupPopovers(root);
        popovers.setupPopovers(root);
        root.firstElementChild.dispatchEvent(new MouseEvent('mouseenter'));
        popovers.cleanupPopovers(root);
        root.remove();
    }, popoverURL);
    await page.waitForTimeout(200);
    await expect(page.locator('.popover-container')).toBeHidden();
});
