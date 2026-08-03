# Issue 35 Challenge Command Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove issue #35's same-page Challenge command sequencing race and expose the controls' existing pending state to assistive technology without suppressing the Challenge live region.

**Architecture:** `ChallengePanel.svelte` gains a controls-only wrapper whose explicit `aria-busy` value mirrors the existing shared `actionRunner.pending` state; the live announcement remains its sibling. The shared Playwright `clickCommand` helper separately diagnoses click actionability, command transport/outcome, and sender-side UI settlement. A hand-written `page.setContent` fixture tests the helper contract independently of application auth and campaign setup.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript strict, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-02-issue-35-challenge-command-lifecycle-design.md`
**Issue:** https://github.com/arrowedisgaming/guild-book/issues/35

## Global Constraints

- Keep the `aria-live="polite"` Challenge announcement outside every `aria-busy` subtree.
- Mirror `actionRunner.pending` directly; do not introduce a second lifecycle state machine.
- Keep each click, post-click response, and client-settlement phase at 15 seconds. The pre-registered response observer may use a 30-second aggregate timeout because its first 15 seconds overlap the click phase.
- Do not add retries, production sleeps, or changes to `failOnFlakyTests`.
- Preserve the two Challenge journeys' existing 180-second test timeouts.
- Sender-side settlement does not replace cross-client polling (`findActingPage`, `waitForStage`, `anyPageShowsTurnControls`, and `anyoneHasTurnControls`).
- The Challenge command endpoint's response body is required: `POST .../challenge-commands` unconditionally returns JSON containing `outcome` after access control and has no 204 branch.
- Do not change Challenge engine legality, command schemas, server idempotency, privacy projections, store deduplication, or analogous procedure helpers.
- Svelte 5 conventions apply: `$props()` destructuring and existing runes patterns.
- Use Keep a Changelog structure in `CHANGELOG.md`.
- Never add automated-authorship attribution or generated-by footers.
- Work only on the focused `codex/issue-35-lifecycle-signal-plan` branch; do not push to `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/components/campaign/table/challenge/ChallengePanel.svelte` *(modify)* | Controls-only busy boundary, outside the live announcement. |
| `tests/e2e/challenge.spec.ts` *(modify)* | Real-component assertion that the wrapper exists, is idle, and excludes the live region. |
| `tests/unit/components/challenge-action.test.ts` *(modify)* | Characterization coverage for the pending state that drives `aria-busy`. |
| `tests/e2e/fixtures/challenge.ts` *(modify)* | Full click → response/outcome → sender-idle synchronization contract. |
| `tests/e2e/challenge-command-helper.spec.ts` *(create)* | Deterministic hand-written DOM simulation for helper settlement and rejection diagnostics. |
| `CHANGELOG.md` *(modify)* | User-facing accessibility addition under `[Unreleased]`. |

---

### Task 1: Expose the real controls lifecycle without enclosing the live region

**Files:**
- Modify: `tests/e2e/challenge.spec.ts:85`
- Modify: `tests/unit/components/challenge-action.test.ts:17-59`
- Modify: `src/lib/components/campaign/table/challenge/ChallengePanel.svelte:196-221,225-232`

**Interfaces:**
- Consumes: `ChallengeActionRunner.pending: boolean` from `challenge-action.svelte.ts`.
- Produces: exactly one `[data-testid="challenge-controls"]` per visible Challenge panel, with `aria-busy="true" | "false"`; the existing `[data-testid="challenge-announcement"]` remains outside it.

- [ ] **Step 1: Write the failing real-component assertions**

In `tests/e2e/challenge.spec.ts`, immediately after `waitForStage` confirms the first Challenge round, add:

```ts
		for (const page of [gmPage, playerAPage, playerBPage]) {
			const controls = page.getByTestId('challenge-controls');
			await expect(controls).toHaveAttribute('aria-busy', 'false');
			await expect(controls.getByTestId('challenge-announcement')).toHaveCount(0);
			await expect(page.getByTestId('challenge-announcement')).toHaveCount(1);
		}
```

The production mutation this catches is a missing controls wrapper, a busy attribute placed on the panel root, or a live region accidentally moved inside the busy subtree.

- [ ] **Step 2: Add pending-state characterization coverage**

In `tests/unit/components/challenge-action.test.ts`, add the following helper above the describe and tests inside it:

```ts
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
```

```ts
	it('stays pending until a successful send settles', async () => {
		const result = deferred<SendCommandResult>();
		const runner = createChallengeAction(() => result.promise);

		const run = runner.run({ type: 'end-turn' });
		expect(runner.pending).toBe(true);

		result.resolve({ ok: true });
		await run;
		expect(runner.pending).toBe(false);
	});

	it('clears pending after a rejected command outcome', async () => {
		const result = deferred<SendCommandResult>();
		const runner = createChallengeAction(() => result.promise);

		const run = runner.run({ type: 'end-turn' });
		expect(runner.pending).toBe(true);

		result.resolve({ ok: false, message: 'not legal' });
		await run;
		expect(runner.pending).toBe(false);
		expect(runner.error).toBe('not legal');
	});
```

These characterize the already-existing state source. The real-component assertions in Step 1 are the RED test for the production change.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/unit/components/challenge-action.test.ts
npm run test:e2e -- tests/e2e/challenge.spec.ts --retries=0
```

Expected: the Vitest file passes, confirming the pending-state dependency; the Playwright journey fails at `getByTestId('challenge-controls')` because the wrapper does not exist.

- [ ] **Step 4: Add the minimal controls wrapper**

In `ChallengePanel.svelte`, replace the three control blocks with:

```svelte
		<div
			class="challenge-controls"
			data-testid="challenge-controls"
			aria-busy={actionRunner.pending ? 'true' : 'false'}
		>
			{#if challenge}
				<TurnControls
					{role}
					genericProjection={session.projection as SessionPlayerProjection | SessionGmProjection}
					{challenge}
					{legalCommands}
					{actionRunner}
				/>
			{/if}

			{#if role === 'gm'}
				<GmChallengeControls
					genericProjection={session.projection as SessionGmProjection}
					challenge={challenge as ChallengeGmProjection | null}
					{legalCommands}
					roster={challengeRoster}
					{enemyThreatOptions}
					{actionRunner}
				/>
			{/if}

			{#if challenge}
				<ModifierControls
					{role}
					{userId}
					genericProjection={session.projection as SessionPlayerProjection | SessionGmProjection}
					{challenge}
					{legalCommands}
					roster={challengeRoster}
					{actionRunner}
				/>
			{/if}
		</div>
```

Add this style next to `.challenge-panel`:

```css
	.challenge-controls {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the same two commands from Step 3.

Expected: both pass; the live announcement remains outside the busy wrapper.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/lib/components/campaign/table/challenge/ChallengePanel.svelte tests/e2e/challenge.spec.ts tests/unit/components/challenge-action.test.ts
git commit -m "feat(challenge): expose control lifecycle state"
```

---

### Task 2: Make `clickCommand` wait for outcome and sender-side settlement

**Files:**
- Create: `tests/e2e/challenge-command-helper.spec.ts`
- Modify: `tests/e2e/fixtures/challenge.ts:1-40`

**Interfaces:**
- Consumes: `page`, target `locator`, and optional `timeoutMs` through the existing `clickCommand(page, locator, timeoutMs = 15000)` signature.
- Produces: the same `Promise<void>` API, now resolving only after click actionability, a successful JSON command outcome, and `[data-testid="challenge-controls"][aria-busy="false"]` on the sending page.

- [ ] **Step 1: Write the deterministic failing helper tests**

Create `tests/e2e/challenge-command-helper.spec.ts`:

```ts
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
			'challenge command via getByTestId(\'command-button\') was rejected (illegal-command): not legal now'
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
```

The production mutations caught are removing the sender-idle wait, ignoring `outcome.ok`, or returning to the ambiguous `Promise.all` failure ordering.

- [ ] **Step 2: Run the helper spec and verify RED**

Run:

```bash
npm run test:e2e -- tests/e2e/challenge-command-helper.spec.ts --retries=0
```

Expected: all three tests fail against the old helper: it resolves while the lifecycle gate is held, accepts the HTTP-200 rejected outcome, and reports `page.waitForResponse` for the disabled button.

- [ ] **Step 3: Implement the lifecycle-aware helper**

Replace the `clickCommand` implementation and its comment in `tests/e2e/fixtures/challenge.ts` with:

```ts
/**
 * Completes one Challenge interaction in three diagnostic phases: the target
 * becomes actionable and receives a click, the server returns a successful
 * JSON outcome, and the sending page finishes applying that response.
 */
export async function clickCommand(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const responseResultPromise = page
		.waitForResponse(
			(response) => response.url().includes('/challenge-commands') && response.request().method() === 'POST',
			{ timeout: timeoutMs * 2 }
		)
		.then(
			(response) => ({ ok: true as const, response }),
			(cause: unknown) => ({ ok: false as const, cause })
		);

	await locator.click({ timeout: timeoutMs });

	const responseResult = await responseResultPromise;
	if (!responseResult.ok) throw responseResult.cause;
	const { response } = responseResult;

	let responseText: string;
	try {
		responseText = await response.text();
	} catch (cause) {
		throw new Error(`challenge command via ${locator} returned an unreadable body (HTTP ${response.status()})`, { cause });
	}

	let body: unknown;
	try {
		body = JSON.parse(responseText);
	} catch (cause) {
		if (!response.ok()) {
			throw new Error(`challenge command via ${locator} failed (HTTP ${response.status()}): ${responseText}`, { cause });
		}
		throw new Error(`challenge command via ${locator} returned invalid JSON (HTTP ${response.status()}): ${responseText}`, { cause });
	}

	const outcome =
		typeof body === 'object' && body !== null && 'outcome' in body && typeof body.outcome === 'object' && body.outcome !== null
			? body.outcome
			: null;
	const code = outcome && 'code' in outcome && typeof outcome.code === 'string' ? outcome.code : null;
	const message = outcome && 'message' in outcome && typeof outcome.message === 'string' ? outcome.message : null;
	const detail = [code ? ` (${code})` : '', message ? `: ${message}` : ''].join('');

	if (!response.ok()) {
		throw new Error(`challenge command via ${locator} failed (HTTP ${response.status()})${detail}`);
	}
	if (!outcome || !('ok' in outcome) || outcome.ok !== true) {
		throw new Error(`challenge command via ${locator} was rejected${detail}`);
	}

	// `pending = true` is set synchronously by the click handler. Svelte's
	// microtask flush therefore renders busy=true before the later network task
	// can deliver this response, so this cannot false-pass on pre-click "false".
	await expect(page.getByTestId('challenge-controls')).toHaveAttribute('aria-busy', 'false', { timeout: timeoutMs });
}
```

- [ ] **Step 4: Run the helper spec and verify GREEN**

Run the command from Step 2.

Expected: 3 passed, 0 failed.

- [ ] **Step 5: Run the two real Challenge journeys**

Run:

```bash
npm run test:e2e -- tests/e2e/challenge.spec.ts tests/e2e/challenge-privacy.spec.ts --workers=2 --retries=0
```

Expected: 2 passed, 0 failed within each journey's unchanged 180-second timeout.

- [ ] **Step 6: Commit Task 2**

```bash
git add tests/e2e/fixtures/challenge.ts tests/e2e/challenge-command-helper.spec.ts
git commit -m "test(e2e): await Challenge command lifecycle"
```

---

### Task 3: Document and verify the completed fix

**Files:**
- Modify: `CHANGELOG.md:9-10`

**Interfaces:**
- Consumes: the completed user-visible busy-state behavior from Task 1.
- Produces: one Keep a Changelog `[Unreleased]` entry; no application interface.

- [ ] **Step 1: Add the user-facing changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Added

- Challenge controls now report when they are processing an action to assistive
  technology, without delaying the Challenge's live turn announcements.
```

Do not add a separate entry for the internal Playwright helper.

- [ ] **Step 2: Run focused stress verification**

Run both Challenge journeys three times with the CI-relevant worker count and retries disabled:

```bash
npm run test:e2e -- tests/e2e/challenge.spec.ts tests/e2e/challenge-privacy.spec.ts --repeat-each=3 --workers=2 --retries=0
```

Expected: 6 passed, 0 flaky, 0 failed.

- [ ] **Step 3: Run repository validation**

Run:

```bash
npm run check
npm test
npm run test:e2e
```

Expected: all commands exit 0 with no failures; CI's existing `failOnFlakyTests` policy is unchanged.

- [ ] **Step 4: Review the diff against the spec**

Run:

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

Confirm every acceptance criterion in the design spec is represented by code or a test and no out-of-scope subsystem changed.

- [ ] **Step 5: Commit Task 3**

```bash
git add CHANGELOG.md
git commit -m "docs: note Challenge busy state"
```
