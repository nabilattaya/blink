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

test('refresh scheduler limits concurrent fragment requests', async ({ page }) => {
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
    expect(maximumActive).toBeLessThanOrEqual(3);
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
