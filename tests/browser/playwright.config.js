import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: 'native-refresh.spec.js',
    fullyParallel: false,
    workers: 1,
    timeout: 30_000,
    expect: {
        timeout: 10_000,
    },
    use: {
        baseURL: 'http://127.0.0.1:18080',
        browserName: 'chromium',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'go run . --config tests/browser/glance.yml',
        url: 'http://127.0.0.1:18080/api/healthz',
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
