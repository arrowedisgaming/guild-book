import { expect, test, type Page } from '@playwright/test';
import { clickCommand } from './fixtures/challenge';

const COMMAND_URL = 'http://challenge.test/challenge-commands';

async function installLifecycleFixture(page: Page): Promise<void> {
	await page.setContent(`
		<section data-testid="challenge-controls" aria-busy="false">
			<button data-testid="command-button" type="button">Send command</button>
		</section>
		<script>
			window.clientCompletion = new Promise((resolve) => {
				window.releaseClientCompletion = resolve;
			});
			document.querySelector('[data-testid="command-button"]').addEventListener('click', async () => {
				const controls = document.querySelector('[data-testid="challenge-controls"]');
				controls.setAttribute('aria-busy', 'true');
				const response = await fetch('${COMMAND_URL}', { method: 'POST' });
				await response.json();
				controls.setAttribute('data-response-consumed', 'true');
				await window.clientCompletion;
				controls.setAttribute('aria-busy', 'false');
			});
		</script>
	`);
}

async function releaseClientCompletion(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { releaseClientCompletion: () => void }).releaseClientCompletion();
	});
}

test.describe('Challenge command helper', () => {
	test('waits until the sending controls finish processing the response', async ({ page }) => {
		await page.route('**/challenge-commands', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: { 'access-control-allow-origin': '*' },
				body: JSON.stringify({ outcome: { ok: true, resultingVersion: 2 } })
			})
		);
		await installLifecycleFixture(page);

		let helperSettled = false;
		const interaction = clickCommand(page, page.getByTestId('command-button')).finally(() => {
			helperSettled = true;
		});

		try {
			await expect(page.getByTestId('challenge-controls')).toHaveAttribute('data-response-consumed', 'true');
			await Promise.resolve();
			expect(helperSettled).toBe(false);
		} finally {
			await releaseClientCompletion(page);
		}

		await interaction;
		expect(await page.getByTestId('challenge-controls').getAttribute('aria-busy')).toBe('false');
	});

	test('reports an application-level rejection even when HTTP is 200', async ({ page }) => {
		await page.route('**/challenge-commands', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: { 'access-control-allow-origin': '*' },
				body: JSON.stringify({ outcome: { ok: false, code: 'illegal-command', message: 'not legal now' } })
			})
		);
		await page.setContent(`
			<section data-testid="challenge-controls" aria-busy="false">
				<button data-testid="command-button" type="button">Send command</button>
			</section>
			<script>
				document.querySelector('[data-testid="command-button"]').addEventListener('click', async () => {
					const controls = document.querySelector('[data-testid="challenge-controls"]');
					controls.setAttribute('aria-busy', 'true');
					await fetch('${COMMAND_URL}', { method: 'POST' });
					controls.setAttribute('aria-busy', 'false');
				});
			</script>
		`);

		await expect(clickCommand(page, page.getByTestId('command-button'))).rejects.toThrow(
			"challenge command via getByTestId('command-button') was rejected (illegal-command): not legal now"
		);
	});

	test('surfaces click actionability failure before a response timeout', async ({ page }) => {
		await page.setContent(`
			<section data-testid="challenge-controls" aria-busy="false">
				<button data-testid="command-button" type="button" disabled>Send command</button>
			</section>
		`);

		const message = await clickCommand(page, page.getByTestId('command-button'), 100).then(
			() => '',
			(cause) => String(cause)
		);
		expect(message).toContain('locator.click');
		expect(message).not.toContain('page.waitForResponse');
	});
});
