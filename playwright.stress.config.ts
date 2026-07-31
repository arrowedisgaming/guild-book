import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig(baseConfig, {
	testMatch: [
		'shared-table*.spec.ts',
		'challenge*.spec.ts',
		'campaign-tests-of-fate.spec.ts',
		'camp-procedures.spec.ts'
	],
	workers: 8,
	retries: 0,
	repeatEach: 3,
	failOnFlakyTests: true,
	reporter: [['list']],
	use: {
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'off'
	}
});
