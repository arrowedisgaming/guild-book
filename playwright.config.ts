import { defineConfig } from '@playwright/test';

const isCI = process.env.CI === 'true';

export default defineConfig({
	webServer: {
		command:
			'node scripts/e2e/setup-db.mjs && npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
		port: 4173,
		reuseExistingServer: false,
		env: {
			...process.env,
			NODE_ENV: 'development',
			AUTH_DEV_LOGIN: 'true',
			AUTH_DEV_AUTOLOGIN: 'false',
			AUTH_SECRET: process.env.AUTH_SECRET ?? 'guild-book-e2e-secret',
			ORIGIN: 'http://localhost:4173',
			CAMPAIGNS_ENABLED: 'true',
			CAMPAIGN_INVITE_SECRET: 'guild-book-e2e-invite-secret',
			DATABASE_URL: '.tmp/guild-book-e2e.db'
		}
	},
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: isCI ? 2 : undefined,
	retries: isCI ? 1 : 0,
	failOnFlakyTests: isCI,
	outputDir: 'test-results/artifacts',
	reporter: isCI
		? [
				['list'],
				['html', { outputFolder: 'playwright-report', open: 'never' }],
				['junit', { outputFile: 'test-results/junit.xml' }]
			]
		: [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	}
});
