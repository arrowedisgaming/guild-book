import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Playwright release configuration', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it('uses bounded concurrency and fails retry-only passes in CI while retaining diagnostics', async () => {
		vi.stubEnv('CI', 'true');
		vi.resetModules();
		const { default: config } = await import('../../playwright.config');

		expect(config.workers).toBe(2);
		expect(config.retries).toBe(1);
		expect(config.failOnFlakyTests).toBe(true);
		const webServer = config.webServer as { stdout?: string; stderr?: string };
		expect(webServer.stdout).toBe('pipe');
		expect(webServer.stderr).toBe('pipe');
		expect(config.use).toMatchObject({
			trace: 'on-first-retry',
			screenshot: 'only-on-failure',
			video: 'retain-on-failure'
		});
		expect(config.reporter).toEqual(
			expect.arrayContaining([
				['list'],
				['html', expect.objectContaining({ outputFolder: 'playwright-report', open: 'never' })],
				['junit', expect.objectContaining({ outputFile: 'test-results/junit.xml' })]
			])
		);
	});
});
