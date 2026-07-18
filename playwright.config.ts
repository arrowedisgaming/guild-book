import { defineConfig } from '@playwright/test';

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
			AUTH_URL: 'http://localhost:4173',
			ORIGIN: 'http://localhost:4173',
			CAMPAIGNS_ENABLED: 'true',
			CAMPAIGN_INVITE_SECRET: 'guild-book-e2e-invite-secret',
			DATABASE_URL: '.tmp/guild-book-e2e.db'
		}
	},
	testDir: 'tests/e2e',
	fullyParallel: false,
	use: {
		baseURL: 'http://localhost:4173'
	}
});
