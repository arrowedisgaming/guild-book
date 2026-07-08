import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		env: {
			...process.env,
			// The preview server refuses to boot without an auth secret; e2e only
			// exercises public pages, so any value will do.
			AUTH_SECRET: process.env.AUTH_SECRET ?? 'guild-book-e2e-secret'
		}
	},
	testDir: 'tests/e2e',
	use: {
		baseURL: 'http://localhost:4173'
	}
});
