import { cleanupPopovers, setupPopovers } from './popover.js';
import { cleanupMasonries, setupMasonries } from './masonry.js';
import { setupNativeWidgetRefresh } from './native-refresh.js';
import { throttledDebounce, isElementVisible, openURLInNewTab } from './utils.js';
import { elem, find, findAll } from './templating.js';

async function fetchPageContent(pageData) {
    // TODO: handle non 200 status codes/time outs
    // TODO: add retries
    const response = await fetch(`${pageData.baseURL}/api/pages/${pageData.slug}/content/`);
    const content = await response.text();

    return content;
}

function queryElements(root, selector) {
    const elements = Array.from(root.querySelectorAll(selector));

    if (root instanceof Element && root.matches(selector)) {
        elements.unshift(root);
    }

    return elements;
}

let carouselResizeListenerInitialized = false;

function updateCarouselSideCutoffs(carousel) {
    const itemsContainer =
        carousel.getElementsByClassName(
            "carousel-items-container"
        )[0];

    if (itemsContainer === undefined) {
        return;
    }

    if (itemsContainer.scrollLeft != 0) {
        carousel.classList.add(
            "show-left-cutoff"
        );
    } else {
        carousel.classList.remove(
            "show-left-cutoff"
        );
    }

    if (
        Math.ceil(itemsContainer.scrollLeft) +
            itemsContainer.clientWidth <
        itemsContainer.scrollWidth
    ) {
        carousel.classList.add(
            "show-right-cutoff"
        );
    } else {
        carousel.classList.remove(
            "show-right-cutoff"
        );
    }
}

function setupCarousels(root = document) {
    const carouselElements = queryElements(
        root,
        ".carousel-container"
    );

    if (carouselElements.length == 0) {
        return;
    }

    if (!carouselResizeListenerInitialized) {
        const updateAllCarouselSideCutoffs =
            throttledDebounce(() => {
                const currentCarousels =
                    document.getElementsByClassName(
                        "carousel-container"
                    );

                for (
                    let i = 0;
                    i < currentCarousels.length;
                    i++
                ) {
                    updateCarouselSideCutoffs(
                        currentCarousels[i]
                    );
                }
            }, 20, 100);

        window.addEventListener(
            "resize",
            updateAllCarouselSideCutoffs
        );

        carouselResizeListenerInitialized = true;
    }

    for (
        let i = 0;
        i < carouselElements.length;
        i++
    ) {
        const carousel = carouselElements[i];
        const itemsContainer =
            carousel.getElementsByClassName(
                "carousel-items-container"
            )[0];

        if (itemsContainer === undefined) {
            continue;
        }

        carousel.classList.add(
            "show-right-cutoff"
        );

        const determineSideCutoffs = () => {
            updateCarouselSideCutoffs(carousel);
        };

        itemsContainer.addEventListener(
            "scroll",
            throttledDebounce(
                determineSideCutoffs,
                20,
                100
            )
        );

        afterContentReady(
            determineSideCutoffs
        );
    }
}

const minuteInSeconds = 60;
const hourInSeconds = minuteInSeconds * 60;
const dayInSeconds = hourInSeconds * 24;
const monthInSeconds = dayInSeconds * 30.4;
const yearInSeconds = dayInSeconds * 365;

function timestampToRelativeTime(timestamp) {
    let delta = Math.round((Date.now() / 1000) - timestamp);
    let prefix = "";

    if (delta < 0) {
        delta = -delta;
        prefix = "in ";
    }

    if (delta < minuteInSeconds) {
        return prefix + "1m";
    }
    if (delta < hourInSeconds) {
        return prefix + Math.floor(delta / minuteInSeconds) + "m";
    }
    if (delta < dayInSeconds) {
        return prefix + Math.floor(delta / hourInSeconds) + "h";
    }
    if (delta < monthInSeconds) {
        return prefix + Math.floor(delta / dayInSeconds) + "d";
    }
    if (delta < yearInSeconds) {
        return prefix + Math.floor(delta / monthInSeconds) + "mo";
    }

    return prefix + Math.floor(delta / yearInSeconds) + "y";
}

function updateRelativeTimeForElements(elements)
{
    for (let i = 0; i < elements.length; i++)
    {
        const element = elements[i];
        const timestamp = element.dataset.dynamicRelativeTime;

        if (timestamp === undefined)
            continue

        element.textContent = timestampToRelativeTime(timestamp);
    }
}

let searchShortcutInitialized = false;

function setupSearchBoxes(root = document) {
    const searchWidgets = queryElements(root, ".search");

    if (searchWidgets.length == 0) {
        return;
    }

    if (!searchShortcutInitialized) {
        document.addEventListener("keydown", (event) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
            if (event.code != "KeyS") return;

            const inputs = Array.from(
                document.querySelectorAll(".search .search-input")
            );
            const inputElement = inputs.find(isElementVisible) || inputs[0];

            if (inputElement === undefined) return;

            inputElement.focus();
            event.preventDefault();
        });
        searchShortcutInitialized = true;
    }

    for (let i = 0; i < searchWidgets.length; i++) {
        const widget = searchWidgets[i];
        const defaultSearchUrl = widget.dataset.defaultSearchUrl;
        const target = widget.dataset.target || "_blank";
        const newTab = widget.dataset.newTab === "true";
        const inputElement = widget.getElementsByClassName("search-input")[0];
        const bangElement = widget.getElementsByClassName("search-bang")[0];
        const bangs = widget.querySelectorAll(".search-bangs > input");
        const bangsMap = {};
        const kbdElement = widget.getElementsByTagName("kbd")[0];
        let currentBang = null;
        let lastQuery = "";

        for (let j = 0; j < bangs.length; j++) {
            const bang = bangs[j];
            bangsMap[bang.dataset.shortcut] = bang;
        }

        const handleKeyDown = (event) => {
            if (event.key == "Escape") {
                inputElement.blur();
                return;
            }

            if (event.key == "Enter") {
                const input = inputElement.value.trim();
                let query;
                let searchUrlTemplate;

                if (currentBang != null) {
                    query = input.slice(currentBang.dataset.shortcut.length + 1);
                    searchUrlTemplate = currentBang.dataset.url;
                } else {
                    query = input;
                    searchUrlTemplate = defaultSearchUrl;
                }
                if (query.length == 0 && currentBang == null) {
                    return;
                }

                const url = searchUrlTemplate.replace("!QUERY!", encodeURIComponent(query));

                if (newTab && !event.ctrlKey || !newTab && event.ctrlKey) {
                    window.open(url, target).focus();
                } else {
                    window.location.href = url;
                }

                lastQuery = query;
                inputElement.value = "";
                changeCurrentBang(null);

                return;
            }

            if (event.key == "ArrowUp" && lastQuery.length > 0) {
                inputElement.value = lastQuery;
                return;
            }
        };

        const changeCurrentBang = (bang) => {
            currentBang = bang;
            bangElement.textContent = bang != null ? bang.dataset.title : "";
        }

        const handleInput = (event) => {
            const value = event.target.value.trim();
            if (value in bangsMap) {
                changeCurrentBang(bangsMap[value]);
                return;
            }

            const words = value.split(" ");
            if (words.length >= 2 && words[0] in bangsMap) {
                changeCurrentBang(bangsMap[words[0]]);
                return;
            }

            changeCurrentBang(null);
        };

        inputElement.addEventListener("keydown", handleKeyDown);
        inputElement.addEventListener("input", handleInput);

        kbdElement.addEventListener("mousedown", () => {
            requestAnimationFrame(() => inputElement.focus());
        });
    }
}

function setupDynamicRelativeTime() {
    const updateInterval = 60 * 1000;
    let lastUpdateTime = Date.now();

    const updateElements = () => {
        updateRelativeTimeForElements(
            document.querySelectorAll(
                "[data-dynamic-relative-time]"
            )
        );
    };

    updateElements();

    const updateElementsAndTimestamp = () => {
        updateElements();
        lastUpdateTime = Date.now();
    };

    const scheduleRepeatingUpdate = () => setInterval(updateElementsAndTimestamp, updateInterval);

    if (document.hidden === undefined) {
        scheduleRepeatingUpdate();
        return;
    }

    let timeout = scheduleRepeatingUpdate();

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearTimeout(timeout);
            return;
        }

        const delta = Date.now() - lastUpdateTime;

        if (delta >= updateInterval) {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
            return;
        }

        timeout = setTimeout(() => {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
        }, updateInterval - delta);
    });
}

function setupGroups(root = document) {
    const groups = queryElements(root, ".widget-type-group");

    if (groups.length == 0) {
        return;
    }

    for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const titles = group.getElementsByClassName("widget-header")[0].children;
        const tabs = group.getElementsByClassName("widget-group-contents")[0].children;
        let current = 0;

        for (let t = 0; t < titles.length; t++) {
            const title = titles[t];

            if (title.dataset.titleUrl !== undefined) {
                title.addEventListener("mousedown", (event) => {
                    if (event.button != 1) {
                        return;
                    }

                    openURLInNewTab(title.dataset.titleUrl, false);
                    event.preventDefault();
                });
            }

            title.addEventListener("click", () => {
                if (t == current) {
                    if (title.dataset.titleUrl !== undefined) {
                        openURLInNewTab(title.dataset.titleUrl);
                    }

                    return;
                }

                for (let i = 0; i < titles.length; i++) {
                    titles[i].classList.remove("widget-group-title-current");
                    titles[i].setAttribute("aria-selected", "false");
                    tabs[i].classList.remove("widget-group-content-current");
                    tabs[i].setAttribute("aria-hidden", "true");
                }

                if (current < t) {
                    tabs[t].dataset.direction = "right";
                } else {
                    tabs[t].dataset.direction = "left";
                }

                current = t;

                title.classList.add("widget-group-title-current");
                title.setAttribute("aria-selected", "true");
                tabs[t].classList.add("widget-group-content-current");
                tabs[t].setAttribute("aria-hidden", "false");
            });
        }
    }
}

function setupLazyImages(root = document) {
    const images = queryElements(root, "img[loading=lazy]");

    if (images.length == 0) {
        return;
    }

    function imageFinishedTransition(image) {
        image.classList.add("finished-transition");
    }

    afterContentReady(() => {
        setTimeout(() => {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];

                if (image.complete) {
                    image.classList.add("cached");
                    setTimeout(() => imageFinishedTransition(image), 1);
                } else {
                    // TODO: also handle error event
                    image.addEventListener("load", () => {
                        image.classList.add("loaded");
                        setTimeout(() => imageFinishedTransition(image), 400);
                    });
                }
            }
        }, 1);
    });
}

function attachExpandToggleButton(collapsibleContainer) {
    const showMoreText = "Show more";
    const showLessText = "Show less";

    let expanded = false;
    const button = document.createElement("button");
    const icon = document.createElement("span");
    icon.classList.add("expand-toggle-button-icon");
    const textNode = document.createTextNode(showMoreText);
    button.classList.add("expand-toggle-button");
    button.append(textNode, icon);
    button.addEventListener("click", () => {
        expanded = !expanded;

        if (expanded) {
            collapsibleContainer.classList.add("container-expanded");
            button.classList.add("container-expanded");
            textNode.nodeValue = showLessText;
            return;
        }

        const topBefore = button.getClientRects()[0].top;

        collapsibleContainer.classList.remove("container-expanded");
        button.classList.remove("container-expanded");
        textNode.nodeValue = showMoreText;

        const topAfter = button.getClientRects()[0].top;

        if (topAfter > 0)
            return;

        window.scrollBy({
            top: topAfter - topBefore,
            behavior: "instant"
        });
    });

    collapsibleContainer.after(button);

    return button;
};


function setupCollapsibleLists(root = document) {
    const collapsibleLists = queryElements(
        root,
        ".list.collapsible-container"
    );

    if (collapsibleLists.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleLists.length; i++) {
        const list = collapsibleLists[i];

        if (list.dataset.collapseAfter === undefined) {
            continue;
        }

        const collapseAfter = parseInt(list.dataset.collapseAfter);

        if (collapseAfter == -1) {
            continue;
        }

        if (list.children.length <= collapseAfter) {
            continue;
        }

        attachExpandToggleButton(list);

        for (let c = collapseAfter; c < list.children.length; c++) {
            const child = list.children[c];
            child.classList.add("collapsible-item");
            child.style.animationDelay = ((c - collapseAfter) * 20).toString() + "ms";
        }
    }
}

const collapsibleGridObservers = new WeakMap();

function setupCollapsibleGrids(root = document) {
    const collapsibleGridElements = queryElements(
        root,
        ".cards-grid.collapsible-container"
    );

    if (collapsibleGridElements.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleGridElements.length; i++) {
        const gridElement = collapsibleGridElements[i];

        if (
            gridElement.dataset.collapseAfterRows === undefined ||
            collapsibleGridObservers.has(gridElement)
        ) {
            continue;
        }

        const collapseAfterRows = parseInt(gridElement.dataset.collapseAfterRows);

        if (collapseAfterRows == -1) {
            continue;
        }

        const getCardsPerRow = () => {
            return parseInt(getComputedStyle(gridElement).getPropertyValue('--cards-per-row'));
        };

        const button = attachExpandToggleButton(gridElement);

        let cardsPerRow;

        const resolveCollapsibleItems = () => requestAnimationFrame(() => {
            const hideItemsAfterIndex = cardsPerRow * collapseAfterRows;

            if (hideItemsAfterIndex >= gridElement.children.length) {
                button.style.display = "none";
            } else {
                button.style.removeProperty("display");
            }

            let row = 0;

            for (let i = 0; i < gridElement.children.length; i++) {
                const child = gridElement.children[i];

                if (i >= hideItemsAfterIndex) {
                    child.classList.add("collapsible-item");
                    child.style.animationDelay = (row * 40).toString() + "ms";

                    if (i % cardsPerRow + 1 == cardsPerRow) {
                        row++;
                    }
                } else {
                    child.classList.remove("collapsible-item");
                    child.style.removeProperty("animation-delay");
                }
            }
        });

        const observer = new ResizeObserver(() => {
            if (!isElementVisible(gridElement)) {
                return;
            }

            const newCardsPerRow = getCardsPerRow();

            if (cardsPerRow == newCardsPerRow) {
                return;
            }

            cardsPerRow = newCardsPerRow;
            resolveCollapsibleItems();
        });

        collapsibleGridObservers.set(gridElement, observer);
        afterContentReady(() => observer.observe(gridElement));
    }
}

const contentReadyCallbacks = [];
let contentReady = false;

function afterContentReady(callback) {
    if (contentReady) {
        callback();
        return;
    }

    contentReadyCallbacks.push(callback);
}

function markContentReady() {
    contentReady = true;

    const callbacks = contentReadyCallbacks.splice(0);
    for (let i = 0; i < callbacks.length; i++) {
        callbacks[i]();
    }
}

const weekDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function makeSettableTimeElement(element, hourFormat) {
    const fragment = document.createDocumentFragment();
    const hour = document.createElement('span');
    const minute = document.createElement('span');
    const amPm = document.createElement('span');
    fragment.append(hour, document.createTextNode(':'), minute);

    if (hourFormat == '12h') {
        fragment.append(document.createTextNode(' '), amPm);
    }

    element.append(fragment);

    return (date) => {
        const hours = date.getHours();

        if (hourFormat == '12h') {
            amPm.textContent = hours < 12 ? 'AM' : 'PM';
            hour.textContent = hours % 12 || 12;
        } else {
            hour.textContent = hours < 10 ? '0' + hours : hours;
        }

        const minutes = date.getMinutes();
        minute.textContent = minutes < 10 ? '0' + minutes : minutes;
    };
};

function timeInZone(now, zone) {
    let timeInZone;

    try {
        timeInZone = new Date(now.toLocaleString('en-US', { timeZone: zone }));
    } catch (e) {
        // TODO: indicate to the user that this is an invalid timezone
        console.error(e);
        timeInZone = now
    }

    const diffInMinutes = Math.round((timeInZone.getTime() - now.getTime()) / 1000 / 60);

    return { time: timeInZone, diffInMinutes: diffInMinutes };
}

function zoneDiffText(diffInMinutes) {
    if (diffInMinutes == 0) {
        return "";
    }

    const sign = diffInMinutes < 0 ? "-" : "+";
    const signText = diffInMinutes < 0 ? "behind" : "ahead";

    diffInMinutes = Math.abs(diffInMinutes);

    const hours = Math.floor(diffInMinutes / 60);
    const minutes = diffInMinutes % 60;
    const hourSuffix = hours == 1 ? "" : "s";

    if (minutes == 0) {
        return { text: `${sign}${hours}h`, title: `${hours} hour${hourSuffix} ${signText}` };
    }

    if (hours == 0) {
        return { text: `${sign}${minutes}m`, title: `${minutes} minutes ${signText}` };
    }

    return { text: `${sign}${hours}h~`, title: `${hours} hour${hourSuffix} and ${minutes} minutes ${signText}` };
}

const clockTimers = new WeakMap();

function setupClocks(root = document) {
    const clocks = queryElements(root, '.clock');

    if (clocks.length == 0) {
        return;
    }

    for (let i = 0; i < clocks.length; i++) {
        const clock = clocks[i];

        if (clockTimers.has(clock)) {
            continue;
        }

        const hourFormat = clock.dataset.hourFormat;
        const localTimeContainer = clock.querySelector('[data-local-time]');
        const localDateElement = localTimeContainer.querySelector('[data-date]');
        const localWeekdayElement = localTimeContainer.querySelector('[data-weekday]');
        const localYearElement = localTimeContainer.querySelector('[data-year]');
        const timeZoneContainers = clock.querySelectorAll('[data-time-in-zone]');
        const updateCallbacks = [];

        const setLocalTime = makeSettableTimeElement(
            localTimeContainer.querySelector('[data-time]'),
            hourFormat
        );

        updateCallbacks.push((now) => {
            setLocalTime(now);
            localDateElement.textContent = now.getDate() + ' ' + monthNames[now.getMonth()];
            localWeekdayElement.textContent = weekDayNames[now.getDay()];
            localYearElement.textContent = now.getFullYear();
        });

        for (let z = 0; z < timeZoneContainers.length; z++) {
            const timeZoneContainer = timeZoneContainers[z];
            const diffElement = timeZoneContainer.querySelector('[data-time-diff]');

            const setZoneTime = makeSettableTimeElement(
                timeZoneContainer.querySelector('[data-time]'),
                hourFormat
            );

            updateCallbacks.push((now) => {
                const { time, diffInMinutes } = timeInZone(now, timeZoneContainer.dataset.timeInZone);
                setZoneTime(time);
                const diff = zoneDiffText(diffInMinutes);
                diffElement.textContent = diff.text || "";
                diffElement.title = diff.title || "";
            });
        }

        const updateClock = () => {
            if (!clock.isConnected) {
                clockTimers.delete(clock);
                return;
            }

            const now = new Date();

            for (let c = 0; c < updateCallbacks.length; c++) {
                updateCallbacks[c](now);
            }

            const timer = setTimeout(
                updateClock,
                (60 - now.getSeconds()) * 1000
            );
            clockTimers.set(clock, timer);
        };

        clockTimers.set(clock, null);
        updateClock();
    }
}

async function setupCalendars(root = document) {
    const elems = queryElements(root, ".calendar")
        .filter((element) => !Object.prototype.hasOwnProperty.call(element, "component"));
    if (elems.length == 0) return;

    // TODO: implement prefetching, currently loads as a nasty waterfall of requests
    const calendar = await import ('./calendar.js');

    for (let i = 0; i < elems.length; i++)
        calendar.default(elems[i]);
}

async function setupTodos(root = document) {
    const elems = queryElements(root, ".todo");
    if (elems.length == 0) return;

    const todo = await import ('./todo.js');

    for (let i = 0; i < elems.length; i++){
        todo.default(elems[i]);
    }
}

function setupRelativeTimeInElement(element) {
    updateRelativeTimeForElements(
        queryElements(
            element,
            "[data-dynamic-relative-time]"
        )
    );
}

function setupTruncatedElementTitles(root = document) {
    const elements = queryElements(
        root,
        ".text-truncate, .single-line-titles .title, .text-truncate-2-lines, .text-truncate-3-lines"
    );

    if (elements.length == 0) {
        return;
    }

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.getAttribute("title") === null)
            element.title = element.innerText.trim().replace(/\s+/g, " ");
    }
}

async function initializeContent(root = document) {
    setupPopovers(root);
    setupClocks(root);
    await setupCalendars(root);
    await setupTodos(root);
    setupCarousels(root);
    setupSearchBoxes(root);
    setupCollapsibleLists(root);
    setupCollapsibleGrids(root);
    setupGroups(root);
    setupMasonries(root);
    setupRelativeTimeInElement(root);
    setupLazyImages(root);

    setTimeout(() => {
        setupTruncatedElementTitles(root);
    }, 50);
}

function cleanupContent(root) {
    cleanupPopovers(root);
    cleanupMasonries(root);

    const clocks = queryElements(root, '.clock');
    for (let i = 0; i < clocks.length; i++) {
        const timer = clockTimers.get(clocks[i]);
        if (timer !== undefined && timer !== null) {
            clearTimeout(timer);
        }
        clockTimers.delete(clocks[i]);
    }

    const grids = queryElements(
        root,
        ".cards-grid.collapsible-container"
    );
    for (let i = 0; i < grids.length; i++) {
        const observer = collapsibleGridObservers.get(grids[i]);
        if (observer !== undefined) {
            observer.disconnect();
            collapsibleGridObservers.delete(grids[i]);
        }
    }

    const calendars = queryElements(root, '.calendar');
    for (let i = 0; i < calendars.length; i++) {
        if (typeof calendars[i].component?.suspend === "function") {
            calendars[i].component.suspend();
        }
    }
}

async function changeTheme(key, onChanged) {
    const themeStyleElem = find("#theme-style");

    const response = await fetch(`${pageData.baseURL}/api/set-theme/${key}`, {
        method: "POST",
    });

    if (response.status != 200) {
        alert("Failed to set theme: " + response.statusText);
        return;
    }
    const newThemeStyle = await response.text();

    const tempStyle = elem("style")
        .html("* { transition: none !important; }")
        .appendTo(document.head);

    themeStyleElem.html(newThemeStyle);
    document.documentElement.setAttribute("data-theme", key);
    document.documentElement.setAttribute("data-scheme", response.headers.get("X-Scheme"));
    typeof onChanged == "function" && onChanged();
    setTimeout(() => { tempStyle.remove(); }, 10);
}

function initThemePicker() {
    const themeChoicesInMobileNav = find(".mobile-navigation .theme-choices");
    if (!themeChoicesInMobileNav) return;

    const themeChoicesInHeader = find(".header-container .theme-choices");

    if (themeChoicesInHeader) {
        themeChoicesInHeader.replaceWith(
            themeChoicesInMobileNav.cloneNode(true)
        );
    }

    const presetElems = findAll(".theme-choices .theme-preset");
    let themePreviewElems = document.getElementsByClassName("current-theme-preview");
    let isLoading = false;

    presetElems.forEach((presetElement) => {
        const themeKey = presetElement.dataset.key;

        if (themeKey === undefined) {
            return;
        }

        if (themeKey == pageData.theme) {
            presetElement.classList.add("current");
        }

        presetElement.addEventListener("click", () => {
            if (themeKey == pageData.theme) return;
            if (isLoading) return;

            isLoading = true;
            changeTheme(themeKey, function() {
                isLoading = false;
                pageData.theme = themeKey;
                presetElems.forEach((e) => { e.classList.remove("current"); });

                Array.from(themePreviewElems).forEach((preview) => {
                    preview.querySelector(".theme-preset").replaceWith(
                        presetElement.cloneNode(true)
                    );
                })

                presetElems.forEach((e) => {
                    if (e.dataset.key != themeKey) return;
                    e.classList.add("current");
                });
            });
        });
    })
}

async function setupPage() {
    initThemePicker();

    const pageElement = document.getElementById("page");
    const pageContentElement = document.getElementById("page-content");
    const pageContent = await fetchPageContent(pageData);

    pageContentElement.innerHTML = pageContent;

    try {
        await initializeContent(document);
        setupDynamicRelativeTime();
        setupNativeWidgetRefresh({
            baseURL: pageData.baseURL,
            initializeContent,
            cleanupContent,
        });
    } finally {
        pageElement.classList.add("content-ready");
        pageElement.setAttribute("aria-busy", "false");
        markContentReady();

        setTimeout(() => {
            document.body.classList.add("page-columns-transitioned");
        }, 300);
    }
}

setupPage();
