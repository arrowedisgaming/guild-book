# Issue 44 Responsive Procedure Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the complete campaign procedure stack exactly once in both desktop and mobile layouts, with the correction surface available only to GMs.

**Architecture:** `TableShell.svelte` will define one parameterless Svelte 5 `procedureStack()` snippet that closes over the shell's existing props and renders Challenge, Test of Fate, Group Test, Camp, Crawl, Oracle, and the GM-only Correction dialog. Both responsive branches will render that snippet between `PublicTable` and their layout-specific auxiliary/private content. Existing browser journeys will drop duplicate-masking `.first()` calls for panel and correction locators, while the mobile journey adds explicit desktop/mobile count and role assertions.

**Tech Stack:** SvelteKit 2, Svelte 5 runes and snippets, TypeScript strict, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-issue-44-responsive-procedure-panels-design.md`
**Issue:** https://github.com/arrowedisgaming/guild-book/issues/44

## Global Constraints

- Keep `TableShell.svelte` as the composition boundary; do not add a new component file.
- Define the procedure sequence once with `{#snippet procedureStack()}` and render it from both responsive branches with `{@render procedureStack()}`.
- Preserve the procedure order: Challenge, Test of Fate, Group Test, Camp, Crawl, Oracle, GM-only Correction.
- Keep `PublicTable` first in the mobile DOM and keep `MobileTableDrawers`, `PrivateHand`, and `PrivateFacedown` outside the snippet.
- Keep `CorrectionDialog` inside `role === 'gm'`; players must render zero correction controls.
- Do not change procedure visibility, authorization, command dispatch, privacy projection, `matchMedia`, responsive breakpoint, engines, schemas, server code, content packs, or database code.
- Reload after changing the GM viewport to 320px so the mobile assertion exercises the narrow-layout initialization path.
- Remove `.first()` only from affected procedure-panel and correction locators. Keep it on `/^Play/`, `/^Discard/`, and `finite-outcome-*` locators for the reasons recorded in the spec.
- Preserve the existing 320 CSS-pixel DOM-order, keyboard, hand-scroller, overflow, and 200%-zoom assertions.
- Use Keep a Changelog structure in `CHANGELOG.md`.
- Never add automated-authorship attribution, generated-by footers, or automated co-author trailers.
- Work only on `codex/issue-44-responsive-panels-plan`; do not push to `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/components/campaign/table/TableShell.svelte` *(modify)* | Single in-file procedure-stack definition and one render site per responsive branch. |
| `tests/e2e/campaign-mobile.spec.ts` *(modify)* | Desktop/mobile uniqueness, mobile role gating, and existing responsive regression checks. |
| `tests/e2e/exploration-tarot.spec.ts` *(modify)* | Strict finite-panel locators for real Oracle/Crawl workflows. |
| `tests/e2e/session-history.spec.ts` *(modify)* | Strict correction-control and dialog locators for the audited correction workflow. |
| `CHANGELOG.md` *(modify)* | User-facing fix under `[Unreleased]`. |

---

### Task 1: Make responsive procedure composition single-source and regression-tested

**Files:**
- Modify: `tests/e2e/campaign-mobile.spec.ts:5-10,23-125`
- Modify: `tests/e2e/exploration-tarot.spec.ts:66-115,145-160`
- Modify: `tests/e2e/session-history.spec.ts:57-64`
- Modify: `src/lib/components/campaign/table/TableShell.svelte:276-382`
- Modify: `CHANGELOG.md:9`

**Interfaces:**
- Consumes: the existing `TableShell` props `role`, `userId`, `session`, `events`, `challengeRoster`, `enemyThreatOptions`, `procedureTitles`, and the five procedure/correction command callbacks.
- Produces: a local `procedureStack(): Snippet` definition through Svelte's `{#snippet}` syntax; exactly one rendered `finite-panel-crawl` and `finite-panel-cross-phase` per visible table; exactly one `open-correction` for GMs and zero for players.

- [ ] **Step 1: Add failing responsive composition assertions**

In `tests/e2e/campaign-mobile.spec.ts`, update the file comment and test name so they include procedure parity. After the desktop GM starts the session and `Draw a card` is visible, add:

```ts
	await expect(gmPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(gmPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(gmPage.getByTestId('open-correction')).toHaveCount(1);
```

After the 320px player table loads, add:

```ts
	await expect(playerAPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(playerAPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(playerAPage.getByTestId('open-correction')).toHaveCount(0);
```

Then exercise the mobile GM initialization path explicitly:

```ts
	await gmPage.setViewportSize({ width: 320, height: 720 });
	await gmPage.reload();
	await expect(gmPage.getByTestId('mobile-drawers')).toBeAttached();
	await expect(gmPage.getByTestId('finite-panel-crawl')).toHaveCount(1);
	await expect(gmPage.getByTestId('finite-panel-cross-phase')).toHaveCount(1);
	await expect(gmPage.getByTestId('open-correction')).toHaveCount(1);
```

Do not remove or relax the test's existing table-first, keyboard, hand-scroller, 320px overflow, or 200%-zoom checks.

- [ ] **Step 2: Make the existing functional journeys enforce uniqueness**

In `tests/e2e/exploration-tarot.spec.ts`, replace every affected panel locator of this form:

```ts
gmPage.getByTestId('finite-panel-cross-phase').first()
playerAPage.getByTestId('finite-panel-cross-phase').first()
```

with strict locators:

```ts
gmPage.getByTestId('finite-panel-cross-phase')
playerAPage.getByTestId('finite-panel-cross-phase')
```

This applies to `oraclePicker`, direct Begin/Advance/Complete calls, the actor picker, `playerAdvance`, and the `panel`/`playerPanel` variables. Leave all `finite-outcome-*` `.first()` calls and the `/^Discard/` button `.first()` unchanged.

In `tests/e2e/session-history.spec.ts`, change only the correction locators:

```ts
	const openCorrection = gmPage.getByTestId('open-correction');
	// ...
	const dialog = gmPage.getByTestId('correction-dialog');
```

Keep the `/^Play/` button `.first()` because the GM can legitimately have multiple playable cards.

- [ ] **Step 3: Run the focused browser tests and verify RED**

Run:

```bash
npx playwright test tests/e2e/campaign-mobile.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts --retries=0
```

Expected: FAIL before production changes. The mobile spec reports two desktop Crawl/Oracle/Correction mounts and zero mobile mounts; the functional specs may also fail strict locator resolution because the affected desktop controls have two matches.

- [ ] **Step 4: Define the single procedure-stack snippet**

In `TableShell.svelte`, immediately after `</script>` and before the root `.table-shell` markup, add:

```svelte
{#snippet procedureStack()}
	<ChallengePanel
		{role}
		{userId}
		{session}
		{events}
		{challengeRoster}
		{enemyThreatOptions}
		onSendChallengeCommand={onSendChallengeCommand}
	/>
	<TestOfFatePanel {role} {session} roster={challengeRoster} {onSendGuidedTestCommand} />
	<GroupTestPanel {role} {session} roster={challengeRoster} {onSendGuidedTestCommand} />
	<CampProcedurePanel {role} {session} roster={challengeRoster} {onSendCampCommand} />
	<CrawlProcedurePanel
		{role}
		{userId}
		{session}
		roster={challengeRoster}
		{procedureTitles}
		{onSendFiniteCommand}
	/>
	<OraclePanel
		{role}
		{userId}
		{session}
		roster={challengeRoster}
		{procedureTitles}
		{onSendFiniteCommand}
	/>
	{#if role === 'gm'}
		<CorrectionDialog {session} {events} {onSendCorrectionCommand} />
	{/if}
{/snippet}
```

The snippet has no parameters and no state of its own; it closes over the same values the two branches currently use.

- [ ] **Step 5: Render the snippet once in each responsive branch**

In the desktop `.table-column`, replace both duplicated procedure blocks between `PublicTable` and `PrivateHand` with:

```svelte
				{@render procedureStack()}
```

In `.mobile-layout`, replace the existing Challenge/Test of Fate/Group Test/Camp block between `PublicTable` and `MobileTableDrawers` with the same render call:

```svelte
			{@render procedureStack()}
```

Do not move `PublicTable`, `MobileTableDrawers`, `PrivateHand`, or `PrivateFacedown` into the snippet.

- [ ] **Step 6: Run the focused browser tests and verify GREEN**

Run:

```bash
npx playwright test tests/e2e/campaign-mobile.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts --retries=0
```

Expected: all three files pass. The functional Oracle and correction workflows resolve strict locators, and the responsive fixture retains its existing layout, keyboard, overflow, and zoom guarantees.

- [ ] **Step 7: Add the release note**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
### Fixed

- Campaign tables now show Crawl, Oracle, and GM correction controls once on
  desktop and make the same controls available on mobile. Their shared
  procedure stack now has one source definition so the responsive layouts
  cannot drift independently again (#44).
```

- [ ] **Step 8: Run the complete verification gate**

Run:

```bash
npx playwright test tests/e2e/campaign-mobile.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts --retries=0
npm run check
npm test
git diff --check
```

Expected: every command exits 0; the Playwright run reports all focused journeys passing; Svelte check reports zero errors and warnings; Vitest reports the full suite passing; `git diff --check` emits no output.

- [ ] **Step 9: Commit the implementation**

```bash
git add CHANGELOG.md src/lib/components/campaign/table/TableShell.svelte tests/e2e/campaign-mobile.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts
git commit -m "fix(campaigns): keep procedure panels in sync"
```
