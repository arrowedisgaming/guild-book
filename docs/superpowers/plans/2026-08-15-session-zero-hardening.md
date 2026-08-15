# Session-Zero Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three session-zero findings: the identity step's Continue button dead-locking on autofilled fields, the missing Bonds step in the creation wizard, and the site refusing to render inside iframes (Zoom whiteboard embeds).

**Architecture:** Three independent fixes on one branch (`fix/session-zero-hardening`), each with its own tests and commit. The Bonds step is content-pack-driven (new `bonds.json` collection), inserted into `WIZARD_STEPS` between Quest & Motifs and Gear, with a versioned localStorage migration so in-flight drafts survive the re-index. The identity gate switches from a reactively-disabled button (breaks when browser autofill fills fields without firing input events) to click-time validation that reads the DOM directly. Embedding is unlocked by dropping the blanket `X-Frame-Options: DENY` header.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript strict, Zod, Vitest, Playwright.

**Spec:** User direction (2026-08-15 session): (1) name remains required — typing then erasing must re-block Continue; (2) new wizard step after motifs, before gear: per bond one dropdown of book bond types + one text field for the guild-mate's name; (3) the site must render in a plain `<iframe src="https://guildbook.arrowed.games/">`.

## Global Constraints

- `main` is PR-only; work on branch `fix/session-zero-hardening`; never push to `main`.
- All game data changes go in content-pack JSON, not application code (CLAUDE.md).
- Game text is reproduced **verbatim** under the Adherent of the Worm licence — do not paraphrase bond descriptions in `bonds.json`.
- Content-pack changes require a pack version bump (4.2.1 → 4.3.0) and a digest rewrite via `node scripts/content-import/verify-pack-version.mjs --write`, or `release:verify` fails.
- Engine/store functions stay pure; Svelte 5 runes conventions (`$props()`, `$state()`, `$derived`).
- No automated-authorship attribution in commits.
- CHANGELOG.md follows Keep a Changelog; entries go under `## [Unreleased]`.

---

### Task 1: Identity step — Continue gate that survives autofill

The button is currently `disabled={!name.trim()}` with `name` synced via `bind:value`. Browser autofill can populate a field without firing the `input` event, so the store thinks the field is empty while the user sees text — a dead button with no explanation (the session-zero lockup). Replace with an always-enabled button that validates at click time by reading the DOM (`el.value` is ground truth regardless of how the text got there), showing an inline error when the name is empty. Erasing the name and clicking re-blocks with the same error, satisfying the "must re-check on erase" requirement.

**Files:**
- Modify: `src/routes/create/hmtw/identity/+page.svelte`
- Create: `tests/e2e/identity-gate.test.ts`

**Interfaces:**
- Consumes: `wizard` store from `$lib/stores/wizard` (unchanged API).
- Produces: the error copy `Give your adventurer a name to continue.` rendered in a `role="alert"` element — E2E tests key on it.

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/identity-gate.test.ts`:

```ts
import { expect, test } from '@playwright/test';

test('identity step blocks continue without a name and re-blocks after erasing it', async ({
	page
}) => {
	await page.goto('/create/hmtw/identity');

	// Empty form: clicking Continue must explain itself, not advance.
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toHaveText('Give your adventurer a name to continue.');
	await expect(page).toHaveURL(/\/create\/hmtw\/identity$/);

	// Type a name, erase it: still blocked (the session-zero regression).
	const nameField = page.getByLabel('Name', { exact: true });
	await nameField.fill('Mara');
	await nameField.fill('');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toHaveText('Give your adventurer a name to continue.');
	await expect(page).toHaveURL(/\/create\/hmtw\/identity$/);

	// A real name proceeds, and the error clears.
	await nameField.fill('Mara of the Lantern');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/\/create\/hmtw\/kith$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/identity-gate.test.ts`
Expected: FAIL — the first `click()` times out because the button is `disabled` today.

- [ ] **Step 3: Implement click-time DOM validation**

Replace the `<script>` block and relevant template lines of `src/routes/create/hmtw/identity/+page.svelte`:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';

	const STEP = 0;

	let name = $state($wizard.character.name);
	let pronouns = $state($wizard.character.pronouns);
	let appearance = $state($wizard.character.appearance);
	let nameError = $state('');

	let nameEl: HTMLInputElement | undefined = $state();
	let pronounsEl: HTMLInputElement | undefined = $state();
	let appearanceEl: HTMLTextAreaElement | undefined = $state();

	function persist() {
		if (name.trim()) nameError = '';
		wizard.updateCharacter((c) => ({ ...c, name, pronouns, appearance }));
	}

	function next() {
		// Browser autofill can populate fields without firing the input events
		// bind:value listens for, so the DOM is the ground truth at the gate.
		name = nameEl?.value ?? name;
		pronouns = pronounsEl?.value ?? pronouns;
		appearance = appearanceEl?.value ?? appearance;
		persist();
		if (!name.trim()) {
			nameError = 'Give your adventurer a name to continue.';
			return;
		}
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>
```

Template changes:
- `<input type="text" bind:this={nameEl} bind:value={name} oninput={persist} placeholder="e.g. Phynn, Dorian…" />`
- `<input type="text" bind:this={pronounsEl} bind:value={pronouns} oninput={persist} placeholder="e.g. she/her" />`
- `<textarea bind:this={appearanceEl} bind:value={appearance} oninput={persist} rows="3" placeholder="What do you look like?"></textarea>`
- Immediately before `<WizardNav …>` insert:

```svelte
{#if nameError}
	<p class="name-error" role="alert">{nameError}</p>
{/if}

<WizardNav onContinue={next} />
```

(Note `continueDisabled` is removed.) Add to the `<style>` block:

```css
.name-error {
	margin: 1rem 0 -1rem;
	color: var(--accent);
	font-size: 0.9rem;
}
```

- [ ] **Step 4: Run the E2E test to verify it passes**

Run: `npx playwright test tests/e2e/identity-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/create/hmtw/identity/+page.svelte tests/e2e/identity-gate.test.ts
git commit -m "fix(wizard): validate identity name at click time, surviving autofill"
```

---

### Task 2: Content pack — bond types collection

Add `bonds.json` (verbatim book text for the 11 bond types), register it in the manifest and Zod schemas, expose it from the loader, and re-stamp the pack (version 4.3.0 + digest).

**Files:**
- Create: `static/content-packs/hmtw/bonds.json`
- Modify: `static/content-packs/hmtw/index.json` (add `files.bonds`, bump `version` to `4.3.0`; digest rewritten by script)
- Modify: `src/lib/schemas/content-pack.schema.ts` (add `bonds` to `contentPackFilesSchema`; add `bondTypeDefinitionSchema`, `bondTypesFileSchema`)
- Modify: `src/lib/types/content-pack.ts` (add `BondTypeDefinition`, `BondTypesFile`)
- Modify: `src/lib/server/content/loader.ts` (import, cache, `getBondTypes()`, add `bondTypes` to `loadWizardData()`)
- Create: `tests/unit/bond-types.test.ts`
- Modify (if it enumerates files): `static/content-packs/hmtw/README.md`

**Interfaces:**
- Produces: `getBondTypes(): BondTypeDefinition[]` where `BondTypeDefinition = { id: string; label: string; description: string; examples: string; charge: string[] }`; `loadWizardData()` gains `bondTypes: BondTypeDefinition[]` (flows into every wizard page's `data` prop via the existing `/create/hmtw/+layout.server.ts`).
- Consumed by: Task 4's bonds page (`data.bondTypes`).

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/bond-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getBondTypes, loadWizardData } from '$lib/server/content/loader';

describe('bond types collection', () => {
	it('loads the 11 book bond types with unique ids, Ally first', () => {
		const types = getBondTypes();
		expect(types).toHaveLength(11);
		expect(types[0]).toMatchObject({ id: 'ally', label: 'Ally' });
		expect(new Set(types.map((t) => t.id)).size).toBe(types.length);
		for (const t of types) {
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.charge.length).toBeGreaterThan(0);
		}
	});

	it('ships bond types in the wizard data bundle', () => {
		expect(loadWizardData().bondTypes).toHaveLength(11);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/unit/bond-types.test.ts`
Expected: FAIL — `getBondTypes` is not exported.

- [ ] **Step 3: Author `static/content-packs/hmtw/bonds.json`**

Text is copied **verbatim** from the pack's own `rules.json` entry `adventurer-bonds` (already licence-cleared). Full file:

```json
{
	"types": [
		{
			"id": "ally",
			"label": "Ally",
			"description": "Your allies are guild-mates that you are professional and amiable with. This is the default Bond.",
			"examples": "Wash and Kaylee, Aragorn and Gandalf",
			"charge": ["Charge this Bond when you make your ally laugh both in and out of character."]
		},
		{
			"id": "adversary",
			"label": "Adversary",
			"description": "If you have a significant problem with a guild-mate, you’re probably their adversary. This isn’t an excuse to be an ass to another player, but it’s an opportunity for interesting and fair conflict.",
			"examples": "Mal and Jayne, Boromir and Aragorn",
			"charge": ["Charge this Bond when you witness your adversary fail a test of fate."]
		},
		{
			"id": "big-little",
			"label": "Big/Little",
			"description": "There's a special relationship between a diminutive halfling and her huge troll “brother.” If one adventurer is bigger than the other and you use this to your advantage, this is the Bond for you.",
			"examples": "Éowyn and Merry",
			"charge": ["You both charge this Bond when your big/little aids you in a test of fate with your weakest attribute."]
		},
		{
			"id": "best-friend",
			"label": "Best Friend",
			"description": "You wouldn't let your best friend go on an adventure without you. You're there for each other, thick or thin.",
			"examples": "Mal and Zoe, Merry and Pippin",
			"charge": ["You both charge this Bond when you reveal a secret to your best friend."]
		},
		{
			"id": "love",
			"label": "Love",
			"description": "If both players are cool with it, use this Bond to represent someone you are in a romantic relationship with. If the relationship is one-sided, use the Unrequited Love Bond.",
			"examples": "Zoe and Wash, Faramir and Éowyn",
			"charge": ["Charge this Bond when you do something gushy and romantic for your partner, whether it’s writing an in-character love sonnet or risking your neck to pick a bunch of flowers for them."]
		},
		{
			"id": "master-henchman",
			"label": "Master/Henchman",
			"description": "Players can be hirelings. When you have a managerial vs. subservient relationship with another guild-mate, this is your Bond.",
			"examples": "Mal and Wash, Frodo and Sam",
			"charge": [
				"Masters charge this Bond when they give their henchman an agreed-upon payment or compensation.",
				"Henchmen charge this Bond when they use one of their Camp Actions to benefit their master but not themselves."
			]
		},
		{
			"id": "mentor-mentee",
			"label": "Mentor/Mentee",
			"description": "Whether a parent, parent-figure, or merely the guild leader, a mentor guides and shapes the life of a mentee.",
			"examples": "Shepherd Book and River, Gandalf and Frodo",
			"charge": [
				"Mentees charge this Bond when they ask the mentor for advice and it is given.",
				"Mentors charge this Bond when a mentee follows their advice."
			]
		},
		{
			"id": "rival",
			"label": "Rival",
			"description": "You are in competition with your rival. You might want the same woman, the most kills, or something weirder.",
			"examples": "Legolas and Gimli",
			"charge": ["Charge this Bond when you witness your rival succeed on a test of fate."]
		},
		{
			"id": "sibling",
			"label": "Sibling",
			"description": "Your first adventures were raiding your mother's cookie jar together. Now, you're guild-mates.",
			"examples": "Simon and River, Boromir and Faramir",
			"charge": ["Charge this Bond when you provide aid to your sibling in a test of fate."]
		},
		{
			"id": "unrequited-love",
			"label": "Unrequited Love",
			"description": "He’s just not that into you. If both players are cool with it, use this Bond to represent how you feel about a would-be suitor or ex-lover.",
			"examples": "Simon and Kaylee, Aragorn and Éowyn",
			"charge": ["Charge this Bond when you do something kind for your love and they rebuff you or turn you down."]
		},
		{
			"id": "ward",
			"label": "Ward",
			"description": "You have a guild-mate that you look out for. It’s important they survive.",
			"examples": "Frodo, River",
			"charge": ["When your Ward survives an entire Challenge without taking a Wound, charge this Bond."]
		}
	]
}
```

- [ ] **Step 4: Register in manifest, schema, types, loader**

`static/content-packs/hmtw/index.json`: change `"version": "4.2.1"` → `"version": "4.3.0"`, and inside `"files"` add `"bonds": "bonds.json",` after the `"afflictions"` line (key order inside `files` is not digest-sensitive — the digest sorts keys — but keep it near its siblings).

`src/lib/schemas/content-pack.schema.ts` — in `contentPackFilesSchema` add after `afflictions`:

```ts
	bonds: z.string().optional(),
```

and next to the other collection-file schemas (after `afflictionsFileSchema`-area) add:

```ts
export const bondTypeDefinitionSchema = z.object({
	id: z.string(),
	label: z.string(),
	description: z.string(),
	examples: z.string(),
	charge: z.array(z.string()).min(1)
});

/** bonds.json — the book's example Bond types for the creation wizard. */
export const bondTypesFileSchema = z.object({
	types: z.array(bondTypeDefinitionSchema).min(1)
});
```

`src/lib/types/content-pack.ts` — add:

```ts
/** One of the book's example Bond types (bonds.json). */
export interface BondTypeDefinition {
	id: string;
	label: string;
	description: string;
	examples: string;
	charge: string[];
}

export interface BondTypesFile {
	types: BondTypeDefinition[];
}
```

`src/lib/server/content/loader.ts` — add `BondTypeDefinition` and `BondTypesFile` to the type import, `bondTypesFileSchema` to the schema import, plus:

```ts
import bondsJson from '../../../../static/content-packs/hmtw/bonds.json';
```

```ts
let cachedBondTypes: BondTypeDefinition[] | null = null;

export function getBondTypes(): BondTypeDefinition[] {
	if (!cachedBondTypes) {
		cachedBondTypes = parseOrThrow(bondTypesFileSchema, bondsJson, 'bonds.json').types;
	}
	return cachedBondTypes;
}
```

and in `loadWizardData()` add `bondTypes: getBondTypes()` after `afflictions`.

Check `static/content-packs/hmtw/README.md`: if it lists the pack's files, add `bonds.json` to the list.

- [ ] **Step 5: Re-stamp the pack digest and verify**

```bash
node scripts/content-import/verify-pack-version.mjs --write
node scripts/content-import/verify-pack-version.mjs
```

Expected: the second run exits 0 (digest matches, version 4.3.0).

- [ ] **Step 6: Run the tests**

Run: `npm run test -- tests/unit/bond-types.test.ts tests/unit/content-pack.test.ts && npm run check`
Expected: PASS (content-pack tests still green with the new manifest key).

- [ ] **Step 7: Commit**

```bash
git add static/content-packs/hmtw/bonds.json static/content-packs/hmtw/index.json static/content-packs/hmtw/README.md src/lib/schemas/content-pack.schema.ts src/lib/types/content-pack.ts src/lib/server/content/loader.ts tests/unit/bond-types.test.ts
git commit -m "feat(content): bond types collection (pack 4.3.0)"
```

---

### Task 3: Wizard store — insert the Bonds step and migrate stored drafts

`WIZARD_STEPS` gains `bonds` at index 6 (after `story`, before `equipment`). Stored drafts persist step *indices* in localStorage, so a v1 blob's `6` (gear) and `7` (review) must remap to `7`/`8`. Bump `WIZARD_STATE_VERSION` to 2 and remap on migrate.

**Files:**
- Modify: `src/lib/stores/wizard.ts`
- Modify: `src/routes/create/hmtw/equipment/+page.svelte` (line 18: `const STEP = 6;` → `7`)
- Modify: `src/routes/create/hmtw/review/+page.svelte` (line 9: `const STEP = 7;` → `8`)
- Test: `tests/unit/stores/wizard.test.ts`

**Interfaces:**
- Produces: `WIZARD_STEPS` now 9 entries with `{ id: 'bonds', label: 'Bonds', path: '/create/hmtw/bonds' }` at index 6; `migrateWizardState` remaps v1 indices ≥ 6 upward by 1 and stamps `version: 2`.
- Consumed by: Task 4's route (`STEP = 6`); WizardShell needs no change (it derives everything from `WIZARD_STEPS`).

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/stores/wizard.test.ts`, the `storedState` helper builds `version: 1` blobs — leave it, it now represents legacy input. Add inside `describe('wizard state migration', …)`:

```ts
	it('remaps v1 gear/review indices around the inserted bonds step', () => {
		const migrated = migrateWizardState(
			storedState({ currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6] })
		);

		expect(migrated?.version).toBe(2);
		expect(migrated?.currentStep).toBe(8);
		expect(migrated?.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 7]);
	});

	it('leaves pre-bonds v1 indices and v2 blobs untouched', () => {
		const v1 = migrateWizardState(storedState({ currentStep: 5, completedSteps: [0, 4] }));
		expect(v1?.currentStep).toBe(5);
		expect(v1?.completedSteps).toEqual([0, 4]);

		const v2 = migrateWizardState(
			storedState({ version: 2, currentStep: 6, completedSteps: [0, 6] })
		);
		expect(v2?.currentStep).toBe(6);
		expect(v2?.completedSteps).toEqual([0, 6]);
	});

	it('rejects a v1 blob whose step index exceeds the legacy layout', () => {
		expect(migrateWizardState(storedState({ currentStep: 8 }))).toBeNull();
	});
```

Also update the existing boundary test — `it.each([-1, 8, 1.5, NaN])` currently treats `8` as impossible; with 9 steps that only holds for v1 blobs (covered by the new test above). Change it to:

```ts
	it.each([-1, 9, 1.5, Number.NaN])('rejects an impossible current step (%s)', (currentStep) => {
		expect(migrateWizardState(storedState({ version: 2, currentStep }))).toBeNull();
	});
```

and update the `keeps only unique valid completed step indexes` test to stamp `version: 2` in its input and expect `[0, 3]` from `[0, 0, 3, -1, 9, 1.5, '2']`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test -- tests/unit/stores/wizard.test.ts`
Expected: FAIL — no `bonds` step, no remap, migrated version is 1.

- [ ] **Step 3: Implement in `src/lib/stores/wizard.ts`**

Change `WIZARD_STATE_VERSION` to `2`. In `WIZARD_STEPS`, insert between `story` and `equipment`:

```ts
	{ id: 'bonds', label: 'Bonds', path: '/create/hmtw/bonds' },
```

Replace the body of `migrateWizardState` from the `currentStep` validation down to the `return` with:

```ts
	if (typeof candidate.currentStep !== 'number') return null;

	// v2 inserted the Bonds step at index 6; v1 blobs (or unversioned ones)
	// carry indices from the old 8-step layout and shift up around it.
	const version = candidate.version === 2 ? 2 : 1;
	const legacyStepCount = WIZARD_STEPS.length - 1;
	const stepLimit = version === 2 ? WIZARD_STEPS.length : legacyStepCount;
	const remap = (step: number) => (version === 1 && step >= 6 ? step + 1 : step);

	if (
		!Number.isInteger(candidate.currentStep) ||
		candidate.currentStep < 0 ||
		candidate.currentStep >= stepLimit
	) {
		return null;
	}
	const completedSteps = Array.isArray(candidate.completedSteps)
		? [
				...new Set(
					candidate.completedSteps
						.filter(
							(step): step is number =>
								typeof step === 'number' &&
								Number.isInteger(step) &&
								step >= 0 &&
								step < stepLimit
						)
						.map(remap)
				)
			]
		: [];

	return {
		version: WIZARD_STATE_VERSION,
		active: candidate.active === true,
		currentStep: remap(candidate.currentStep),
		completedSteps,
		character: migrateCharacterData(candidate.character),
		nonce: typeof candidate.nonce === 'number' ? candidate.nonce : 0
	};
```

Update the two step constants: `equipment/+page.svelte` `const STEP = 7;`, `review/+page.svelte` `const STEP = 8;`.

- [ ] **Step 4: Run the unit tests**

Run: `npm run test -- tests/unit/stores/wizard.test.ts && npm run check`
Expected: PASS. (The wizard-smoke E2E is now red until Task 4 adds the route — expected; do not run it yet.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/stores/wizard.ts src/routes/create/hmtw/equipment/+page.svelte src/routes/create/hmtw/review/+page.svelte tests/unit/stores/wizard.test.ts
git commit -m "feat(wizard): register bonds step and migrate stored draft indices"
```

---

### Task 4: Bonds wizard page + review section

New route at `/create/hmtw/bonds`: one row per bond — a dropdown of book bond types and a text field for the guild-mate's name — with add/remove. Bonds are optional (a lone player may have no guild-mates yet), stored as the existing `Bond` shape with the chosen type label in `text` (no character-schema change; sheet, share view, and PDF export already render that field). Review page lists them.

**Files:**
- Create: `src/routes/create/hmtw/bonds/+page.svelte`
- Modify: `src/routes/create/hmtw/review/+page.svelte` (add Bonds section)
- Modify: `tests/e2e/wizard-smoke.test.ts` (walk the new step; assert bond on review + saved sheet)

**Interfaces:**
- Consumes: `data.bondTypes: BondTypeDefinition[]` (Task 2, via wizard layout data); `WIZARD_STEPS[6]` = bonds (Task 3); `Bond = { targetName: string; text: string; charged: boolean }` from `$lib/types/character`.
- Produces: bonds persisted on `$wizard.character.bonds`; accessible controls labeled `Bond type` (select) and `Guild-mate's name` (input) — E2E keys on these.

- [ ] **Step 1: Extend the smoke E2E to walk the bonds step (failing first)**

In `tests/e2e/wizard-smoke.test.ts`, first test, after the Quest & Motifs `Continue` click (line ~36) insert:

```ts
	await expect(page).toHaveURL(/\/create\/hmtw\/bonds$/);
	await page.getByLabel("Guild-mate's name").first().fill('Grendel');
	await page.getByLabel('Bond type').first().selectOption('Rival');
	await page.getByRole('button', { name: 'Continue' }).click();
```

In the review assertions block (after the `Disgraced Soldier` line) add:

```ts
	await expect(page.getByText('Grendel — Rival')).toBeVisible();
```

And at the end, after the `Rope ×2` sheet assertion, add:

```ts
	await expect(page.getByText('Grendel')).toBeVisible();
```

The anonymous-review test's seeded blob stays `version: 1, currentStep: 7` on purpose — it now exercises the Task 3 migration (review is index 8 post-remap) and must keep passing unchanged.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/wizard-smoke.test.ts`
Expected: FAIL — continuing from Quest & Motifs lands on `/create/hmtw/bonds`, which 404s (route doesn't exist yet).

- [ ] **Step 3: Create `src/routes/create/hmtw/bonds/+page.svelte`**

```svelte
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 6;
	let { data }: { data: PageData } = $props();

	const DEFAULT_TYPE = 'Ally';

	interface BondRow {
		targetName: string;
		type: string;
		charged: boolean;
	}

	let rows = $state<BondRow[]>(
		untrack(() =>
			$wizard.character.bonds.length
				? $wizard.character.bonds.map((b) => ({
						targetName: b.targetName,
						type: b.text || DEFAULT_TYPE,
						charged: b.charged
					}))
				: [{ targetName: '', type: DEFAULT_TYPE, charged: false }]
		)
	);

	const typeDescription = (label: string) =>
		data.bondTypes.find((t) => t.label === label)?.description ?? '';

	function persist() {
		wizard.updateCharacter((c) => ({
			...c,
			bonds: rows
				.filter((r) => r.targetName.trim())
				.map((r) => ({ targetName: r.targetName.trim(), text: r.type, charged: r.charged }))
		}));
	}

	function addRow() {
		rows = [...rows, { targetName: '', type: DEFAULT_TYPE, charged: false }];
	}

	function removeRow(i: number) {
		rows = rows.filter((_, idx) => idx !== i);
		persist();
	}

	function next() {
		persist();
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Bonds — Guild Book</title></svelte:head>

<h1>Bonds</h1>
<p class="lede">
	Bonds are your relationships with the other members of your guild. Charge them by playing
	them to the hilt; burn charges at camp to heal Wounds and recover Resolve. Name a guild-mate
	and pick the Bond you share — or continue and forge them at the table.
</p>

<div class="bonds">
	{#each rows as row, i (i)}
		<div class="bond-row">
			<label>
				<span>Bond type</span>
				<select aria-label="Bond type" bind:value={row.type} onchange={persist}>
					{#each data.bondTypes as t (t.id)}
						<option value={t.label}>{t.label}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Guild-mate's name</span>
				<input
					type="text"
					aria-label="Guild-mate's name"
					bind:value={row.targetName}
					oninput={persist}
					placeholder="e.g. Grendel"
				/>
			</label>
			<button type="button" class="remove" onclick={() => removeRow(i)} aria-label="Remove bond">
				✕
			</button>
			{#if typeDescription(row.type)}
				<p class="hint">{typeDescription(row.type)}</p>
			{/if}
		</div>
	{/each}
</div>

<button type="button" class="add" onclick={addRow}>+ Add another bond</button>

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.bonds {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		margin-top: 1.5rem;
	}
	.bond-row {
		display: grid;
		grid-template-columns: 1fr 1.5fr auto;
		gap: 0.75rem;
		align-items: end;
	}
	.bond-row label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.bond-row label span {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.bond-row .hint {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	select,
	input {
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
	.remove {
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: transparent;
		cursor: pointer;
	}
	.add {
		margin-top: 1rem;
		padding: 0.45rem 0.9rem;
		border: 1px dashed color-mix(in oklab, var(--ink) 35%, transparent);
		border-radius: 3px;
		background: transparent;
		font: inherit;
		cursor: pointer;
	}
	@media (max-width: 560px) {
		.bond-row {
			grid-template-columns: 1fr auto;
		}
	}
</style>
```

- [ ] **Step 4: Add the Bonds section to the review page**

In `src/routes/create/hmtw/review/+page.svelte`, after the Motifs section (line ~98) insert:

```svelte
{#if char.bonds.length}
	<section><h2>Bonds</h2>
		<ul>{#each char.bonds as b}<li>{b.targetName} — {b.text}</li>{/each}</ul>
	</section>
{/if}
```

- [ ] **Step 5: Run the E2E suite for the wizard**

Run: `npx playwright test tests/e2e/wizard-smoke.test.ts tests/e2e/identity-gate.test.ts`
Expected: PASS — including the untouched anonymous-review migration case.

- [ ] **Step 6: Commit**

```bash
git add src/routes/create/hmtw/bonds src/routes/create/hmtw/review/+page.svelte tests/e2e/wizard-smoke.test.ts
git commit -m "feat(wizard): bonds step with book bond types"
```

---

### Task 5: Allow iframe embedding

Every response currently gets `X-Frame-Options: DENY` (src/hooks.server.ts:76), which is why the site renders as a blank/black box in Zoom whiteboards and plain iframes. Remove it. Risk note for the implementer: Auth.js session cookies are SameSite, so a hostile framing page does not carry the user's session — the clickjacking surface this header guarded is minimal, and the GM embed use-case is explicitly wanted. Verify the cookie config during this task (grep for `sameSite` under `src/lib/server` and the auth config; Auth.js defaults to `lax` when unset) and adjust the code comment if reality differs.

**Files:**
- Modify: `src/hooks.server.ts:76`
- Create: `tests/e2e/embedding.test.ts`

**Interfaces:** none new — header-only change.

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/embedding.test.ts`:

```ts
import { expect, test } from '@playwright/test';

test('pages ship no X-Frame-Options so GM tools can embed the site', async ({ page }) => {
	const response = await page.goto('/');
	expect(response?.headers()['x-frame-options']).toBeUndefined();
	// The other hardening headers must survive the change.
	expect(response?.headers()['x-content-type-options']).toBe('nosniff');
	expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/embedding.test.ts`
Expected: FAIL — header is `DENY`.

- [ ] **Step 3: Remove the header**

In `src/hooks.server.ts`, replace line 76 with a comment so the absence reads as a decision, not an omission:

```ts
	// Deliberately no X-Frame-Options: GMs embed Guild Book in Zoom whiteboards
	// and VTTs (session-zero request). Auth cookies are SameSite, so a framing
	// page cannot ride a signed-in session.
```

(Adjust the second sentence if the Step-1 cookie-config check found otherwise.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/e2e/embedding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.server.ts tests/e2e/embedding.test.ts
git commit -m "fix(embed): drop X-Frame-Options so Guild Book renders in iframes"
```

---

### Task 6: Changelog + full verification + PR

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Changelog entries**

Under `## [Unreleased]` add:

```markdown
### Added

- Bonds step in the creation wizard (after Quest & Motifs): pick a book Bond
  type and name the guild-mate you share it with. The eleven example Bonds
  ship verbatim in content pack 4.3.0's new `bonds.json`.

### Fixed

- The identity step's Continue button no longer dead-locks when the browser
  autofills the name field: the gate now validates the actual field contents
  at click time and explains itself with an inline message instead of a
  silently disabled button. Erasing the name still blocks continuing.

### Changed

- Guild Book pages can now be embedded in iframes (Zoom whiteboards, VTTs) —
  the blanket `X-Frame-Options: DENY` header is gone. Signed-in sessions do
  not carry into cross-site embeds; embedded views are effectively anonymous.
```

- [ ] **Step 2: Full local verification**

```bash
npm run check && npm run test && npx playwright test
```

Expected: all green. (Codex-sandbox reviews can't run E2E — these local runs are the E2E evidence.)

- [ ] **Step 3: Commit, push branch, open PR**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for session-zero hardening"
git push -u origin fix/session-zero-hardening
gh pr create --title "Session-zero hardening: identity gate, wizard bonds step, iframe embedding" --body "Fixes the three session-zero findings: autofill-proof identity Continue gate, a Bonds step in the creation wizard (content pack 4.3.0), and iframe embeddability for GM tools. See docs/superpowers/plans/2026-08-15-session-zero-hardening.md."
```

Merge only after the required `check` and `e2e` jobs pass. Release (v0.20.0 tag) happens separately via the shipit flow after merge.

---

## Self-Review

- **Spec coverage:** (1) name required + re-block on erase → Task 1 test asserts exactly that; (2) bonds step after motifs/before gear, dropdown from book + name field → Tasks 2–4; (3) plain-iframe embedding → Task 5. Covered.
- **Placeholder scan:** all steps carry full code/content; the only conditional instruction (README file list, cookie comment wording) tells the implementer exactly what to check and how to act on either outcome.
- **Type consistency:** `BondTypeDefinition` (Task 2) is the type consumed by `data.bondTypes` in Task 4; `Bond` fields `targetName/text/charged` match `src/lib/types/character.ts:50`; step indices — bonds 6, equipment 7, review 8 — consistent across Tasks 3–4.
