# Content Pack 4.2.0 — Vault Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the HMTW content pack (4.1.0 → 4.2.0) from blockbeard's re-structured corrected vault (`assets-src/hmtw-text-2026-08-08`, symlinked as `assets-src/HMTW_md`) by reconciling the importer manifests with the vault's new heading tree, while keeping every previously shipped rule id resolvable.

**Architecture:** The vault re-transcription restored real sub-headings across all 9 rules chapters (413 new headings) and moved 20 previously *emitted* headings to new paths. The importer manifests (`scripts/content-import/manifest/*.json`) address content by heading-path locators, so each moved heading must be re-pointed (relocation → `idAliases` at the new locator) or retired (content absorbed → `anchorAliases` on the absorbing entry, the "war pigs" pattern). Entry granularity stays as-is: the walk emits H1/H2 (+ explicit `splitDeeper` H3s); new deeper headings merge into their parent entry's body automatically.

**Tech Stack:** Node ESM build scripts (`scripts/content-import/`), Vitest, no app-code changes expected.

## Global Constraints

- Branch: work on `content/pack-4.2.0` (already created off `main`). `main` is PR-only; required checks `check` + `e2e`.
- Permanent URLs: every id in `tests/fixtures/shipped-rule-ids.json` must stay resolvable (live id or alias) — `tests/unit/content-build.test.ts` enforces this; never delete from that file, only append.
- Entry granularity is preserved: add `splitDeeper` **only** to save a previously emitted entry whose heading was demoted below H2. Never invent new entries for the 413 new headings — with ONE sanctioned exception, decided here: Chapter 1's `The Four Phases/The Camp Phase` and `The Four Phases/The City Phase` were promoted to H2 (the old vault carried them as bold lines) and the walker will emit them automatically as `basics-the-camp-phase` and `basics-the-city-phase`. Accept both: they mirror the already-shipped `basics-the-crawl-phase` / `basics-the-challenge-phase` siblings. Append both ids to `tests/fixtures/shipped-rule-ids.json` in Task 5 — do not wait for the completeness assertion to discover them.
- Licensing: no `![`, no `<img`/`<picture`/`<source` in any pack file (guards + CI scan enforce). The vault's `images/` directory is copyrighted and must never be committed; `assets-src` is gitignored — do not change that.
- Kin/arête talent text must NOT be duplicated into kith/kin `description` fields — talents are structured entries in `talents.json` referenced by `masteredTalentId`/`areteTalentId`. A description ending "…the following talent:" is correct and expected.
- Pack version: `static/content-packs/hmtw/index.json` `version` 4.1.0 → 4.2.0, digest re-recorded via `node scripts/content-import/verify-pack-version.mjs --write`. Never edit `contentDigest` by hand.
- The license text and non-affiliation disclaimer in `index.json` are verbatim-mandated — byte-identical, never rewritten.
- No AI attribution anywhere (commits, PR, changelog).
- The vault is the source of truth for TEXT; the manifests are the source of truth for STRUCTURE mapping. When text changed (e.g. fake `### Male names:` headings became plain paragraphs — they are now real H4 headings in the vault, which the walk folds into the parent body), accept the vault.
- `npm run test` must be fully green at every commit; `npm run content:verify` must end the plan at 0 drift across all four importers.

## Reference: the 20 moved/retired emitted headings

| section | shipped id | old locator (4.1.0) | disposition hint |
|---|---|---|---|
| adventurer | `adventurer-prior-to-your-first-session` | `The Call to Adventure/Prior to your first session` | H3 at vault line 917 inside the SKIPPED checklist occ-2 subtree — needs Task 4's walker rescue + `splitDeeper` with existing id |
| adventurer | `adventurer-at-your-first-session` | `The Call to Adventure/At your first session` | H3 at vault line 929 — same treatment |
| adventurer | `adventurer-prior-to-your-second-session` | `The Call to Adventure/Prior to your second session` | H3 at vault line 939 — same treatment |
| adventurer | `adventurer-at-the-end-of-your-second-session` | `The Call to Adventure/At the end of your second session` | H3 at vault line 943 — same treatment |
| kith-and-kin | `kith-area-sense` | `Fay/Fay kin/Wood elf arête talent: Area Sense` | heading now at `Fay/Fay kin/Arête/Wood elf arête talent: Area Sense` (H4, line 284) — relocation |
| challenge-phase | `challenge-set-the-scene` | `0. Set the scene` | detailed section is H2 (vault line 65) under the Flow H1 — auto-emitted; `idAliases` keeps the id |
| challenge-phase | `challenge-phase-special-rules` | `0. Set the scene/Special rules` | H2 at vault line 166: `The Flow of the Challenge Phase/Special rules` — `idAliases` |
| challenge-phase | `challenge-draw-cards` | `0. Set the scene/1. Draw Challenge cards` | H2 at line 235 — `idAliases` |
| challenge-phase | `challenge-play-initiative` | `0. Set the scene/2. Play Initiative` | H2 at line 257 — `idAliases` |
| challenge-phase | `challenge-take-turns` | `0. Set the scene/3. Take turns` | H2 at line 279 — `idAliases` |
| challenge-phase | `challenge-action-value` | `0. Set the scene/3. Take turns/Action value` | H3 at line 300 (NOT H4) — re-point existing `splitDeeper` |
| challenge-phase | `challenge-facedown-cards` | `0. Set the scene/3. Take turns/Facedown cards` | H3 at line 330 — ditto |
| challenge-phase | `challenge-interrupt-actions` | `0. Set the scene/3. Take turns/Interrupt actions` | H3 at line 352 — ditto |
| challenge-phase | `challenge-the-fool` | `0. Set the scene/3. Take turns/The Fool` | H3 at line 360 — ditto |
| challenge-phase | `challenge-minor-actions` | `0. Set the scene/4. Minor actions` | H2 at line 375 — `idAliases` |
| challenge-phase | `challenge-end-the-round` | `0. Set the scene/5. End the round` | H2 — `idAliases` |
| camp-phase | `camp-overland-travel` | `Overland Travel` | locate in new Ch8 tree |
| camp-phase | `camp-phase-overland-actions` | `Overland Travel/Overland actions` | ditto |
| city-phase | `city-phase-example-city-events` | `The Flow of the City Phase/Example City Events` | now `The Flow of the City Phase/3. City Events/Example City Events` |
| city-phase | `city-signs-and-portents` | `The Flow of the City Phase/Signs and Portents` | now `The Flow of the City Phase/3. City Events/Signs and Portents` |

**Decision rule for every row:** if the heading text survives at a new path AND is a candidate level (H1/H2, or an existing `splitDeeper` H3) → `idAliases` / re-pointed `splitDeeper` keeps the id. If it survives only below candidate level → `splitDeeper` with the existing id. Only if the heading is truly gone and its prose merged into another entry → `anchorAliases` on the absorber. Confirm by reading the vault file, not by guessing.

**Path-collision caution (Chapter 7):** the Flow H1 opens with a run of *summary* H3s (`### 0. Set the scene` … `### 5. End the round`, vault lines 29–51) that share paths with the detailed H2 sections below them. The summary H3s are NOT walk candidates and must stay that way — they fold into the Flow entry's body. Do NOT add `splitDeeper` for them: `resolveEntries` matches locators by path (not occurrence), so a `splitDeeper` summary H3 plus the same-path detailed H2 produces a fatal "matches 2 candidates" error.

## Pre-flight (not a coding task)

1. Draft and send a short message to blockbeard confirming `hmtw-text-2026-08-08` is his current intended revision and that a 4.2.0 pack will be built from it (mention its per-file sha256 will be recorded in the coverage ledger, pinning the revision). Do not block Tasks 1–8 on the reply; block the release (Task 10) on it.
2. Worktree inventory (state as of 2026-08-09, verify with `git status --short` before starting): `static/content-packs/hmtw/items.json` and `static/content-packs/hmtw/kiths.json` carry uncommitted modifications that are **disposable reconnaissance artifacts** — output of an exploratory `md-inject` run against the new vault made while scoping this plan (reviewed, then superseded by this plan's Task 6). Restore both (`git checkout -- <file>`) before Task 1 so later builds start clean. This plan document itself is untracked — commit it as part of Task 1's commit. If `git status` shows anything NOT listed here, stop and ask the user before proceeding.

---

### Task 1: Commit the structure-diff scout tool

**Files:**
- Create: `scripts/content-import/ledger-structure-diff.mjs`
- Test: `tests/unit/ledger-structure-diff.test.ts`

**Interfaces:**
- Produces: CLI `node scripts/content-import/ledger-structure-diff.mjs [--section <name>] [--ledger <path>]` printing, per ledger chapter: `LOST <level> <disposition> <locator>#<occurrence>` and `NEW <level> <path>#<occurrence>`, plus a summary line. `--ledger` points at an alternate ledger JSON (used in Task 5 to diff against the pre-reconciliation baseline after the build rewrites the committed ledger). Exports `diffChapter(ledgerChapter, markdown)` returning `{ lost: LedgerHeading[], added: ScannedHeading[] }`.
- Consumes: `scanHeadings` from `./md-walk.mjs`, `scripts/content-import/manifest/rules-coverage-ledger.json`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ledger-structure-diff.test.ts
import { describe, expect, it } from 'vitest';
import { diffChapter } from '../../scripts/content-import/ledger-structure-diff.mjs';

describe('ledger structure diff', () => {
	const ledgerChapter = {
		file: 'x.md',
		section: 'x',
		headings: [
			{ locator: 'Alpha', occurrence: 1, level: 1, disposition: 'emitted', id: 'x-alpha' },
			{ locator: 'Alpha/Beta', occurrence: 1, level: 2, disposition: 'emitted', id: 'x-beta' }
		]
	};

	it('reports a ledger heading missing from the vault as lost', () => {
		const { lost, added } = diffChapter(ledgerChapter, '# Alpha\n\nprose\n');
		expect(lost.map((h) => h.locator)).toEqual(['Alpha/Beta']);
		expect(added).toEqual([]);
	});

	it('reports a vault heading absent from the ledger as added', () => {
		const { lost, added } = diffChapter(ledgerChapter, '# Alpha\n\n## Beta\n\n### Gamma\n');
		expect(lost).toEqual([]);
		expect(added.map((h) => h.path)).toEqual(['Alpha/Beta/Gamma']);
	});

	it('distinguishes occurrences of the same path', () => {
		const { lost } = diffChapter(
			{ ...ledgerChapter, headings: [{ locator: 'Alpha', occurrence: 2, level: 1, disposition: 'emitted' }] },
			'# Alpha\n'
		);
		expect(lost.map((h) => h.occurrence)).toEqual([2]);
	});
});

// CLI coverage for --ledger (the flag Task 5's baseline audit depends on),
// including an absolute path outside the repo. The synthetic ledger uses a
// sentinel section and both emitted/skipped missing rows, so the test proves
// the flag is honored AND the summary counts emitted losses only. Needs the
// vault, so skipped in CI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MD_DIR } from '../../scripts/content-import/md-lib.mjs';

describe.skipIf(!existsSync(MD_DIR))('ledger-structure-diff CLI', () => {
	it('honors an absolute --ledger path and counts only emitted losses', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-test-'));
		const baseline = join(dir, 'baseline.json');
		writeFileSync(
			baseline,
			JSON.stringify([
				{
					file: '01 - Chapter 1 - The Basics.md',
					section: 'cli-ledger-sentinel',
					headings: [
						{
							locator: 'CLI emitted heading that does not exist',
							occurrence: 1,
							level: 1,
							disposition: 'emitted',
							id: 'cli-missing-emitted'
						},
						{
							locator: 'CLI skipped heading that does not exist',
							occurrence: 1,
							level: 2,
							disposition: 'skipped',
							reason: 'summary must not count this row'
						}
					]
				}
			])
		);

		try {
			const out = execFileSync(
				'node',
				['scripts/content-import/ledger-structure-diff.mjs', '--ledger', baseline],
				{ encoding: 'utf8' }
			);
			expect(out).toContain('=== cli-ledger-sentinel');
			expect(out).toContain('LOST L1 [emitted] CLI emitted heading that does not exist#1');
			expect(out).toContain('LOST L2 [skipped] CLI skipped heading that does not exist#1');
			expect(out).toContain('lost emitted headings require manifest attention: 1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ledger-structure-diff.test.ts`
Expected: FAIL — module has no export `diffChapter` (file does not exist).

- [ ] **Step 3: Write the implementation**

```js
// scripts/content-import/ledger-structure-diff.mjs
// @ts-nocheck — plain ESM build script, not part of the typed app surface.
// Reconciliation scout: compares the committed coverage ledger's tracked
// heading structure (emitted/container/skipped rows) against the current
// vault, per chapter. LOST = the ledger locator no longer exists at that
// path/occurrence (a manifest re-point or alias is needed if it was emitted).
// NEW = a current vault heading is absent from the tracked ledger; deeper NEW
// rows are informational unless a manifest anchor must now address them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanHeadings } from './md-walk.mjs';
import { MD_DIR } from './md-lib.mjs';

const key = (path, occurrence) => `${path.toLowerCase()}#${occurrence}`;

export function diffChapter(ledgerChapter, markdown) {
	const { headings } = scanHeadings(markdown);
	const vaultKeys = new Set(headings.map((h) => key(h.path, h.occurrence)));
	const ledgerKeys = new Set(ledgerChapter.headings.map((h) => key(h.locator, h.occurrence)));
	return {
		lost: ledgerChapter.headings.filter((h) => !vaultKeys.has(key(h.locator, h.occurrence))),
		added: headings.filter((h) => !ledgerKeys.has(key(h.path, h.occurrence)))
	};
}

function main() {
	const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
	const only = argAfter('--section');
	const ledgerPath = argAfter('--ledger') ?? 'scripts/content-import/manifest/rules-coverage-ledger.json';
	// resolve(), not join(): join(cwd, '/tmp/x') would nest an absolute path
	// under the repo; resolve() honors absolute --ledger arguments.
	const ledger = JSON.parse(readFileSync(resolve(process.cwd(), ledgerPath), 'utf8'));
	let lostTotal = 0;
	for (const ch of ledger) {
		if (only && ch.section !== only) continue;
		const { lost, added } = diffChapter(ch, readFileSync(join(MD_DIR, ch.file), 'utf8'));
		if (!lost.length && !added.length) continue;
		console.log(`=== ${ch.section} (${ch.file}) lost:${lost.length} new:${added.length}`);
		for (const h of lost) console.log(`  LOST L${h.level} [${h.disposition}] ${h.locator}#${h.occurrence}`);
		for (const h of added) console.log(`  NEW  L${h.level} ${h.path}#${h.occurrence}`);
		lostTotal += lost.filter((h) => h.disposition === 'emitted').length;
	}
	console.log(`lost emitted headings require manifest attention: ${lostTotal}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ledger-structure-diff.test.ts`
Expected: PASS (4 tests: 3 pure diff tests + 1 vault-gated CLI test locally; CI runs the 3 pure tests and reports the CLI test skipped).

- [ ] **Step 5: Run the tool against the real vault, save the baseline**

Run: `node scripts/content-import/ledger-structure-diff.mjs` (bare — no tail pipe; the full output is the working inventory)
Expected: summary line reports 20 lost, spread across 5 of the 9 chapter sections (adventurer 4, kith-and-kin 1, challenge-phase 11, camp-phase 2, city-phase 2 — matches the Reference table). Then preserve the pre-reconciliation ledger as the Task 5 baseline before any build can rewrite it:

```bash
git show HEAD:scripts/content-import/manifest/rules-coverage-ledger.json > /tmp/ledger-baseline-4.1.0.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/content-import/ledger-structure-diff.mjs tests/unit/ledger-structure-diff.test.ts docs/superpowers/plans/2026-08-08-pack-4-2-0-vault-reconciliation.md
git commit -m "feat(content-import): add ledger structure-diff scout for vault reconciliation"
```

(The plan document rides along here so the branch is self-describing.)

---

### Task 2: Chapter 4 walk config — relocate `kith-area-sense`

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json` (the chapter object whose `walk.file` is `04 - Chapter 4 - Kith and Kin.md`)

**Interfaces:**
- Consumes: scout tool from Task 1.
- Produces: `md-rules` progresses past Chapter 4 (its next failure, if any, is a later chapter).

- [ ] **Step 1: Find the entry and its current locator**

Run: `node -e "const m=require('./scripts/content-import/manifest/rules-md.json'); const ch=m.find(c=>c.walk.file.startsWith('04')); console.log(JSON.stringify(ch.walk.splitDeeper?.filter(s=>/Area Sense/.test(s.at)) ?? [], null, 2))"`
Expected: one `splitDeeper` entry with `"at": "Fay/Fay kin/Wood elf arête talent: Area Sense"` and `"id": "kith-area-sense"`.

- [ ] **Step 2: Verify the new path in the vault**

Run: `grep -n "Area Sense" "assets-src/HMTW_md/04 - Chapter 4 - Kith and Kin.md"` and confirm against the scout output that the new full path is `Fay/Fay kin/Arête/Wood elf arête talent: Area Sense` (heading is now H4 under the `Arête` H3 at line 264). Check whether sibling arête talents (Akashic Consciousness, Spout Doom, Uncanny Knowledge) also appear in `splitDeeper` or other locator maps and note their new paths too — fix all Chapter 4 locators in this task, not just the one that crashes first.

- [ ] **Step 3: Update the locator(s)**

Edit the `at` values to the new paths (Edit tool, exact string replace). Do not change `id` values.

- [ ] **Step 4: Verify Chapter 4 in isolation**

A full `md-rules --dry-run` cannot validate this task: Chapter 2 sits earlier in the walk order and still fails until Task 4, masking everything behind it. Walk just this chapter instead:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkChapter, resolveEntries } from './scripts/content-import/md-walk.mjs';
import { MD_DIR } from './scripts/content-import/md-lib.mjs';
const ch = JSON.parse(readFileSync('scripts/content-import/manifest/rules-md.json','utf8')).find(c=>c.walk.file.startsWith('04'));
const { candidates } = walkChapter(readFileSync(join(MD_DIR, ch.walk.file),'utf8'), ch.walk);
const ids = resolveEntries(candidates, ch.walk).map(e=>e.id);
console.log(ids.includes('kith-area-sense') ? 'OK kith-area-sense emitted' : 'MISSING kith-area-sense');
"
```

Expected: exits 0 printing `OK kith-area-sense emitted`. A locator throw or `MISSING` means Step 3 is incomplete. Full-build validation lands in Task 4 Step 4.

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json
git commit -m "content(hmtw): re-point chapter 4 arete-talent locators at the restructured vault"
```

---

### Task 3: Chapter 7 walk config — the Challenge-flow family (11 ids)

**Files:**
- Modify: `scripts/content-import/manifest/rules-md.json` (chapter object for `07 - Chapter 7 - The Challenge Phase.md`)

**Interfaces:**
- Consumes: scout tool; Reference table rows for `challenge-*`.
- Produces: `md-rules` progresses past Chapter 7 with all 11 `challenge-*` ids still assigned.

- [ ] **Step 1: Dump the chapter's current locator maps**

Run: `node -e "const m=require('./scripts/content-import/manifest/rules-md.json'); const ch=m.find(c=>c.walk.file.startsWith('07')); console.log(JSON.stringify({idAliases: ch.walk.idAliases, splitDeeper: ch.walk.splitDeeper, skip: ch.walk.skip, anchorAliases: ch.walk.anchorAliases}, null, 1))"`

- [ ] **Step 2: Map old → new paths with the scout + vault**

Run: `node scripts/content-import/ledger-structure-diff.mjs --section challenge-phase`, then `grep -nE "^#{1,4} " "assets-src/HMTW_md/07 - Chapter 7 - The Challenge Phase.md"`.
The Reference table already records the verified levels and vault lines. The detailed sections (`## 0. Set the scene` line 65, `## Special rules` line 166, `## 1. Draw Challenge cards` line 235, `## 2. Play Initiative` line 257, `## 3. Take turns` line 279, `## 4. Minor actions` line 375, `## 5. End the round`) are H2s under the `# The Flow of the Challenge Phase` H1 — they are auto-emitted candidates. The summary H3 run at lines 29–51 shares their paths but is not a candidate; per the Path-collision caution, leave it alone.

- [ ] **Step 3: Update the locator maps**

In the chapter's `walk` config:
1. `idAliases`: add rows mapping each detailed H2's new path to its shipped id, e.g. `"The Flow of the Challenge Phase/0. Set the scene": "challenge-set-the-scene"`, `"The Flow of the Challenge Phase/Special rules": "challenge-phase-special-rules"`, `"The Flow of the Challenge Phase/1. Draw Challenge cards": "challenge-draw-cards"` — and likewise for Play Initiative, Take turns, Minor actions, End the round. Remove the stale rows for the old `0. Set the scene/…` paths.
2. `splitDeeper`: re-point the four existing entries (`challenge-action-value`, `challenge-facedown-cards`, `challenge-interrupt-actions`, `challenge-the-fool`) to their H3 paths under the relocated parent, e.g. `"The Flow of the Challenge Phase/3. Take turns/Action value"` (they are H3, not H4).
3. Do NOT add any new `splitDeeper` entries for the summary H3s.

- [ ] **Step 4: Verify Chapter 7 in isolation**

A full `md-rules --dry-run` cannot validate this task (Chapter 2 fails earlier in walk order until Task 4). Walk just this chapter and check all 11 ids:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkChapter, resolveEntries } from './scripts/content-import/md-walk.mjs';
import { MD_DIR } from './scripts/content-import/md-lib.mjs';
const ch = JSON.parse(readFileSync('scripts/content-import/manifest/rules-md.json','utf8')).find(c=>c.walk.file.startsWith('07'));
const { candidates } = walkChapter(readFileSync(join(MD_DIR, ch.walk.file),'utf8'), ch.walk);
const have = new Set(resolveEntries(candidates, ch.walk).map(e=>e.id));
const want = ['challenge-set-the-scene','challenge-phase-special-rules','challenge-draw-cards','challenge-play-initiative','challenge-take-turns','challenge-action-value','challenge-facedown-cards','challenge-interrupt-actions','challenge-the-fool','challenge-minor-actions','challenge-end-the-round'];
console.log(JSON.stringify(want.filter(w=>!have.has(w))));
"
```

Expected: exits 0 printing `[]`. A locator throw or any listed id means Step 3 is incomplete. Full-build validation lands in Task 4 Step 4.

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json
git commit -m "content(hmtw): preserve the 11 challenge-flow entry ids across the chapter 7 restructure"
```

---

### Task 4: Walker rescue semantics + Chapters 2, 8, 9 walk configs (8 remaining ids)

**Files:**
- Modify: `scripts/content-import/md-walk.mjs` (walkChapter: ~lines 80–108)
- Modify: `scripts/content-import/manifest/rules-md.json` (chapter objects for files `02`, `08`, `09`)
- Test: `tests/unit/md-walk.test.ts`

**Interfaces:**
- Consumes: scout tool; Reference table rows for `adventurer-*`, `camp-*`, `city-*`.
- Produces: walkChapter semantics — an explicitly named `splitDeeper` subtree SURVIVES inside a skipped parent (rescued as its own candidate); everything else in the skip still vanishes. Plus: `node scripts/content-import/md-rules.mjs` completes with exit 0.

**Why the walker must change (verified):** the Ch2 manifest skips `The Call to Adventure/NEW ADVENTURER CHECKLIST` occurrence 2 ("duplicate all-caps copy") — but the corrected vault inverted the roles: occurrence 1 (vault line 906) is now a short pointer paragraph and occurrence 2 (line 912) holds the four session H3s. `walkChapter` drops any candidate `inSkip` before `isDeeper` is consulted, so the four proposed `splitDeeper` entries die inside the skip. Un-skipping occurrence 2 instead is NOT an option: both occurrences slug to the shipped id `adventurer-new-adventurer-checklist`, and `resolveEntries`' maps match by path only — an unresolvable collision. The no-regression fix is rescue semantics: occ 1's entry keeps shipping, the four named H3s are carved out of the skipped occ 2, and the occ-2 lede stays skipped exactly as 4.1.0 shipped it.

- [ ] **Step 0a: Write the failing walker test**

Add to `tests/unit/md-walk.test.ts` (alongside the existing walkChapter tests — reuse their config/markdown style):

```ts
describe('splitDeeper rescue inside a skipped subtree', () => {
	const md = [
		'# Chapter',
		'', '## Keep me', '', 'kept prose', '',
		'## Skip me', '', 'skipped intro prose', '',
		'### Rescued child', '', 'rescued prose', '',
		'### Doomed child', '', 'doomed prose', ''
	].join('\n');
	const config = {
		skip: [{ at: 'Chapter/Skip me', reason: 'test skip' }],
		splitDeeper: [{ at: 'Chapter/Skip me/Rescued child', id: 'rescued-child' }]
	};

	it('emits an explicitly named splitDeeper candidate from inside a skip', () => {
		const { candidates } = walkChapter(md, config);
		const rescued = candidates.find((c) => c.locator === 'Chapter/Skip me/Rescued child');
		expect(rescued).toBeDefined();
		expect(rescued!.bodyLines.join('\n')).toContain('rescued prose');
	});

	it('still vanishes the rest of the skipped subtree', () => {
		const { candidates } = walkChapter(md, config);
		const all = candidates.flatMap((c) => c.bodyLines).join('\n');
		expect(all).not.toContain('skipped intro prose');
		expect(all).not.toContain('doomed prose');
	});

	it('ledgers the skip root as skipped and the rescued child as a candidate', () => {
		const { ledger } = walkChapter(md, config);
		expect(ledger.find((l) => l.locator === 'Chapter/Skip me')?.disposition).toBe('skipped');
		expect(ledger.find((l) => l.locator === 'Chapter/Skip me/Rescued child')?.disposition).toBe('candidate');
	});
});
```

`walkChapter()` returns candidate objects with `bodyLines` and ledger rows whose
successful pre-resolution disposition is `candidate`; `buildWalk()` performs the
later `candidate` → `emitted` conversion after ids resolve.

- [ ] **Step 0b: Run the test to verify it fails**

Run: `npx vitest run tests/unit/md-walk.test.ts`
Expected: 2 of the 3 new tests FAIL: the rescued candidate is undefined, and its
ledger row is absent. The "still vanishes" test already PASSES because current
skip semantics remove the whole subtree. Any other failure mode means the test
doesn't match walker shapes; fix the test first.

- [ ] **Step 0c: Implement rescue semantics**

In `walkChapter` (`scripts/content-import/md-walk.mjs`):
1. Candidate gate: change `if (inSkip(h.line)) {` to let a rescued candidate through — `if (inSkip(h.line) && !isDeeper(h)) {`.
2. Owned-lines loop: a rescued candidate's own lines are inside its rescuing skip range, so the `if (inSkip(line)) continue;` exclusion must ignore skip ranges that CONTAIN the candidate itself (a skip nested strictly inside the rescued subtree must still be honored): for each candidate compute `const foreignSkip = (line) => skipRanges.some(([a, b]) => line >= a && line < b && !(h.line >= a && h.line < b));` and use it in place of `inSkip` in that loop.
3. Non-rescued candidates behave exactly as before (for them, no containing skip range exists — they were already outside all skips — so `foreignSkip` ≡ `inSkip`).
Keep the change minimal; do not restructure the loop.

- [ ] **Step 0d: Verify the suite**

Run: `npx vitest run tests/unit/md-walk.test.ts tests/unit/rules-coverage.test.ts && npm test`
Expected: new tests PASS, the exactly-once coverage invariant still holds, full suite green.

- [ ] **Step 0e: Commit the walker change**

```bash
git add scripts/content-import/md-walk.mjs tests/unit/md-walk.test.ts
git commit -m "feat(content-import): rescue explicitly named splitDeeper subtrees from skipped parents"
```

- [ ] **Step 1: Chapter 8 — locate Overland Travel**

Run: `grep -nE "^#{1,3} " "assets-src/HMTW_md/08 - Chapter 8 - The Camp Phase.md"`. Find where `Overland Travel` and `Overland actions` now live. If they survive as headings at a new path → `idAliases` entries mapping the new locators to `camp-overland-travel` / `camp-phase-overland-actions` (add `splitDeeper` with the old id instead if demoted below H2). If the prose merged into another section → `anchorAliases` on the absorber.

- [ ] **Step 2: Chapter 9 — re-point the two City Events children**

Per the scout, `Example City Events` and `Signs and Portents` moved under `The Flow of the City Phase/3. City Events/`. They are H3s now → add `splitDeeper` entries `{ "at": "The Flow of the City Phase/3. City Events/Example City Events", "id": "city-phase-example-city-events" }` and `{ "at": "The Flow of the City Phase/3. City Events/Signs and Portents", "id": "city-signs-and-portents" }` (verify exact casing against the vault first; remove any stale `idAliases` rows for the old locators).

- [ ] **Step 3: Chapter 2 — rescue the four session headings from the skipped checklist**

The four session headings survive as H3s inside the SKIPPED `The Call to Adventure/NEW ADVENTURER CHECKLIST` occurrence-2 subtree (vault lines 917/929/939/943) — this is exactly the case Step 0's walker rescue enables. Keep the existing skip row (occurrence 2) unchanged; its `reason` should be updated to reflect reality (e.g. "checklist frame text; its session sub-sections are rescued via splitDeeper"). Add four `splitDeeper` entries keeping the shipped ids, e.g. `{ "at": "The Call to Adventure/NEW ADVENTURER CHECKLIST/Prior to your first session", "id": "adventurer-prior-to-your-first-session" }` (copy exact heading text from the vault; occurrence keys are only needed if a path is ambiguous — these four are unique). Do NOT use `anchorAliases` (they remain distinct entries) and do NOT touch occurrence 1 (`## New adventurer checklist`, line 906) — it stays the emitted `adventurer-new-adventurer-checklist` entry as shipped. Remove any stale `idAliases` rows for the four old H2 paths.

- [ ] **Step 4: Full md-rules build passes**

Run: `node scripts/content-import/md-rules.mjs`
Expected: exit 0 (run bare — no pipelines), `rules.json`, `rules-search.json`, and the coverage ledger rewritten. If a locator error remains, it names the next fix — resolve it with the same decision rule before proceeding.

- [ ] **Step 5: Commit**

```bash
git add scripts/content-import/manifest/rules-md.json
git commit -m "content(hmtw): reconcile chapters 2, 8, 9 walk locators; keep session-checklist entries via splitDeeper"
```

---

### Task 5: Review the rules diff — content, not just structure

**Files:**
- Review (no expected manual edits): `static/content-packs/hmtw/rules.json`, `static/content-packs/hmtw/rules-search.json`, `scripts/content-import/manifest/rules-coverage-ledger.json`

**Interfaces:**
- Consumes: completed md-rules build from Task 4.
- Produces: a reviewed, committed rules.json rebuild.

- [ ] **Step 1: Ledger sanity — against the BASELINE, not the rewritten ledger**

The Task 4 build rewrote the committed ledger from the current vault, so diffing the committed ledger against the vault is tautologically zero. Diff against the 4.1.0 baseline saved in Task 1 instead:

Run: `node scripts/content-import/ledger-structure-diff.mjs --ledger /tmp/ledger-baseline-4.1.0.json` (regenerate the baseline with `git show <pre-reconciliation-sha>:scripts/content-import/manifest/rules-coverage-ledger.json` if /tmp was cleared — any commit before Task 2 works, e.g. `main`).
Expected: the same 20 LOST rows as the Task 1 inventory. For each of the 20, state its disposition explicitly (idAliases relocation / splitDeeper re-emission / anchorAlias retirement) and verify that disposition exists in `rules-md.json`. All 20 accounted for = pass; any row without a disposition = a Task 2–4 gap, fix before proceeding.

- [ ] **Step 2: Permanent-URL test and the two sanctioned new entries**

Append `basics-the-camp-phase` and `basics-the-city-phase` to `tests/fixtures/shipped-rule-ids.json` (the Global Constraints exception — verify the built ids match first: `node -e "const r=require('./static/content-packs/hmtw/rules.json'); console.log(r.filter(x=>/basics-the-(camp|city)-phase/.test(x.id)).map(x=>x.id))"`).
Run: `npx vitest run tests/unit/content-build.test.ts`
Expected: PASS — every ledgered id resolves. If the completeness assertion names any OTHER new id, that is an unplanned entry promotion: investigate against the Global Constraints before appending anything else.

- [ ] **Step 3: Read the body diff for real corrections vs. slice accidents**

Run: `git diff static/content-packs/hmtw/rules.json > /tmp/rules-4.2.0.diff`, then read `/tmp/rules-4.2.0.diff` in full (chunked reads are fine; skipping the tail is not — the review covers every changed line, and a truncated `head` defeats the step).
Accept: restored missing prose, typo fixes, fake-heading demotions (`### Male names:` → plain text), heading-text corrections.
Reject (fix the manifest, not the pack): an entry's body swallowing a neighboring section (compare entry boundaries against the vault), talent text duplicated into any description, lost sidebars.

- [ ] **Step 4: Coverage suite**

Run: `npx vitest run tests/unit/rules-coverage.test.ts tests/unit/rules-ledger.test.ts tests/unit/md-walk.test.ts`
Expected: PASS (the exactly-once coverage invariant is the strongest guard against slice mistakes).

- [ ] **Step 5: Commit**

```bash
git add static/content-packs/hmtw/rules.json static/content-packs/hmtw/rules-search.json scripts/content-import/manifest/rules-coverage-ledger.json tests/fixtures/shipped-rule-ids.json
git commit -m "content(hmtw): rebuild rules from the restructured corrected vault"
```

---

### Task 6: md-inject manifests — kiths slice anchors and friends

**Files:**
- Modify: `scripts/content-import/manifest/md/kiths.json` (and any other `scripts/content-import/manifest/md/*.json` whose anchors broke)
- Review: `static/content-packs/hmtw/kiths.json`, `items.json`, `paths.json`, `talents.json`, `languages.json`

**Interfaces:**
- Consumes: nothing from earlier tasks (md-inject reads the vault directly), but do it after Task 5 so rules noise is out of the way.
- Produces: `node scripts/content-import/md-inject.mjs --check` reports 0 drifted, with no talent duplication.

- [ ] **Step 1: Ownership check, then rebuild and inspect the damage precisely**

Run: `git status --short scripts/content-import/manifest/ static/content-packs/hmtw/` — only the task-relevant paths. Every listed modification must be attributable: either a commit-pending result of an earlier task in THIS plan, or an artifact named in the Pre-flight inventory. Anything unexplained → STOP and ask the user; never `git checkout --` a file you cannot attribute (it may be their work). Files the Pre-flight inventory marks as disposable build artifacts may be restored, citing that inventory.
Then: `node scripts/content-import/md-inject.mjs && git diff --stat static/content-packs/hmtw/`
Known from reconnaissance: kith/kin descriptions overflow into the talent sections because the manifest's `to` anchors stopped matching (md-inject's `sliceBody` falls back to end-of-body when `to` is unmatched — silently). Every kin description that now contains `### Kin talent:` / `#### … talent:` text is an overflow.

- [ ] **Step 2: Re-anchor the slices**

For each overflowing entry in `scripts/content-import/manifest/md/kiths.json`, set its `to` anchor to the first heading of the talent block as the vault now writes it (e.g. `#### Kin talent: Proud and Ancient`, `#### High elf talent: Read the Past` — copy exact text from `grep -n "talent" "assets-src/HMTW_md/04 - Chapter 4 - Kith and Kin.md"`). Where a `from` anchor broke (check any entry whose new description is EMPTY or starts mid-sentence), re-point it the same way.

- [ ] **Step 3: Verify no duplication and review the remaining delta**

Run: `node scripts/content-import/md-inject.mjs && node -e "const k=require('./static/content-packs/hmtw/kiths.json'); const bad=[]; for (const kith of k){ if (/talent:/i.test(kith.description)) bad.push(kith.id); for (const kin of kith.kins ?? []) if (/talent:/i.test(kin.description)) bad.push(kith.id+'/'+kin.id);} console.log(bad)"`
Expected: `[]`. Then `git diff static/content-packs/hmtw/kiths.json static/content-packs/hmtw/items.json` — remaining changes must be genuine text corrections only (e.g. the `quill-and-ink` description fix, the `underfolk.areteTriggers` wording).

- [ ] **Step 4: Zero drift on the check path**

Run: `node scripts/content-import/md-inject.mjs --check`
Expected: `Checked 173 fields across 9 collections, 0 drifted.`

- [ ] **Step 5: Commit**

```bash
git status --short   # every listed file must be one you reviewed in Step 3
git add scripts/content-import/manifest/md/kiths.json static/content-packs/hmtw/kiths.json static/content-packs/hmtw/items.json
# plus ONLY the specific manifest/pack files Step 3's review covered — name each
# explicitly; never stage whole directories.
git commit -m "content(hmtw): re-anchor injected slices at the restructured vault; refresh injected fields"
```

---

### Task 7: Spells and procedures (appendix structures)

**Files:**
- Modify (only if their checks fail): `scripts/content-import/manifest/tarot-procedures-md.json`, spell handling in `scripts/content-import/md-spells.mjs`'s manifest inputs
- Review: `static/content-packs/hmtw/spells.json`, `static/content-packs/hmtw/tarot-procedures.json`, `docs/rules/tarot-procedure-audit.md` (md-procedures writes this audit document alongside the pack file, and its check modes validate it — it is part of this task's output, not a stray diff)

**Interfaces:**
- Consumes: nothing; appendices are independent of chapters 1–9.
- Produces: both importers build and `--check` clean.

- [ ] **Step 1: Run both builds**

Run: `node scripts/content-import/md-spells.mjs && node scripts/content-import/md-procedures.mjs`
The appendix files (`11 - Appendix A - Sorcery.md`, `14 - Appendix D - City Creation.md`, etc.) were not covered by the chapter reconnaissance — expect possible locator/anchor errors of the same kinds. Apply the same decision rule; the licensing guards (`assertNoImageEmbeds`, `assertNoHtmlImages`) will fail loudly if the new vault's appendix content carries embeds — that is a text fix (strip via manifest exclusion), never a guard bypass.

- [ ] **Step 2: Review diffs, then check-mode both**

Run: `git diff static/content-packs/hmtw/spells.json static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md` (text corrections only), then `node scripts/content-import/md-spells.mjs --check && node scripts/content-import/md-procedures.mjs --check`
Expected: `Checked 40 spells, 0 drifted.` / procedures check clean (31 procedures, 194 table rows).

- [ ] **Step 3: Commit**

```bash
git status --short   # every listed file must be one Step 2's diff review covered
git add scripts/content-import/manifest/tarot-procedures-md.json static/content-packs/hmtw/spells.json static/content-packs/hmtw/tarot-procedures.json docs/rules/tarot-procedure-audit.md
# adjust to the files actually touched — name each explicitly; never stage
# whole directories. The audit doc travels with tarot-procedures.json:
# leaving it behind fails the CI audit check.
git commit -m "content(hmtw): reconcile appendix importers with the corrected vault"
```

---

### Task 8: Pack version 4.2.0, digest, changelog

**Files:**
- Modify: `static/content-packs/hmtw/index.json` (version field ONLY by hand; digest via script), `CHANGELOG.md`

- [ ] **Step 1: Bump the pack version**

Edit `static/content-packs/hmtw/index.json`: `"version": "4.1.0"` → `"version": "4.2.0"`. Touch nothing else in the file by hand.

- [ ] **Step 2: Record the digest**

Run: `node scripts/content-import/verify-pack-version.mjs --write && CONTENT_BASE_REF=origin/main node scripts/content-import/verify-pack-version.mjs`
Expected: digest recorded, then verification passes including the changed-content-requires-version-bump gate.

- [ ] **Step 3: Changelog entry**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Changed

- The rules reference tracks the re-structured corrected manuscript (content
  pack 4.2.0): the source vault now carries the book's full sub-heading
  tree, and every importer manifest was re-pointed at it. All previously
  shipped rule ids remain permanent URLs — relocated sections keep their
  ids, including the Challenge-flow sections and the Call to Adventure
  session-checklist entries at their new positions. The Basics chapter
  gains The Camp Phase and The City Phase as entries, matching their Crawl
  and Challenge siblings. Kith and kin descriptions no longer end
  mid-sentence before their kin talent, and injected fields pick up the
  corrected text (quill and ink, underfolk arête triggers).
```

Adjust the last sentence to match what Task 5/6 diffs actually showed; the changelog must describe the real delta, not this plan's prediction.

- [ ] **Step 4: Full unit suite**

Run: `npm test`
Expected: all green (1,600+ tests including the ledger-diff tool's).

- [ ] **Step 5: Commit**

```bash
git add static/content-packs/hmtw/index.json CHANGELOG.md
git commit -m "content(hmtw): pack 4.2.0 — version, digest, changelog"
```

---

### Task 9: Full verification

- [ ] **Step 1: The gate that has been red since 4.1.0**

Run: `npm run content:verify`
Expected: all four importers `--check` at 0 drift AND `verify-pack-version` passes. This is the first time this command can go green on this machine — that is the point of the whole plan.

- [ ] **Step 2: App-level checks**

Run: `npm run check && npm test`
Expected: 0 errors, all tests green.

- [ ] **Step 3: Targeted e2e (locally — never inside a Codex sandbox; it cannot bind ports)**

Run: `npx playwright test tests/e2e/rules-search.spec.ts tests/e2e/rules-attribution.spec.ts`
Expected: all pass against the refreshed text (search artifact was regenerated in Task 4/5).

- [ ] **Step 4: Browser sanity pass**

Start the dev server (preview tooling, not raw Bash), open `/rules/challenge-phase`, and verify: the relocated Challenge-flow sections render, the old deep link `/rules/adventurer#adventurer-prior-to-your-first-session` still lands on its own (re-emitted) entry, `/rules/basics` shows the new Camp/City Phase entries alongside Crawl/Challenge, and no `###` literals or vault syntax appear.

---

### Task 10: Release PR (blocked on blockbeard's confirmation from Pre-flight)

- [ ] **Step 0: Required pre-merge gate (project publishing rule)**

Run: `git fetch origin main && npm run release:verify`
Expected: fully green — this is broader than Task 9 (it adds the tag/version validation, the Cloudflare production build, and both wrangler dry-runs) and the project instructions require it on the release branch before any merge. With the vault reconciled, its final `content:verify` step passes for the first time; a red here is a stop, not a waivable step.

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin content/pack-4.2.0
gh pr create --title "content(hmtw): rebuild the pack from the re-structured corrected vault (4.2.0)" --body "Rebuilds content pack 4.2.0 from blockbeard's confirmed hmtw-text-2026-08-08 vault revision; reconciles all moved heading locators; preserves every shipped rule id; adds the promoted Basics Camp and City Phase entries; and refreshes generated rules, search, injected fields, spells, and tarot procedures. Local verification completed with npm run release:verify. The required check and e2e jobs must pass before merge."
```

- [ ] **Step 2: Checks green, merge**

Run: `gh pr checks --watch` (both `check` and `e2e`), then `gh pr merge --merge`. One e2e retry is acceptable for the known CI-load flake; two failures = investigate, do not merge.

- [ ] **Step 3: App release**

The merged pack deploys only with an app release: run `/shipit` (project skill: two gates, Codex review, tag `v0.19.0` expected — content change = minor). Out of scope for this plan.

---

## Self-Review Notes

- Every Reference-table id is owned by exactly one of Tasks 2–4, with its verified vault level and mechanism recorded in the table; Task 5 Step 1's baseline-ledger disposition audit is the net that catches any id the tasks mishandled, and Step 2's fixture test backs it up.
- The 413 NEW headings need no per-heading work: non-emitted levels fold into parent bodies; the scout tool plus the exactly-once coverage test prove nothing leaks or double-emits. The only entry-set changes are the two sanctioned Chapter 1 promotions (Global Constraints).
- Verification commands run bare (or `--dry-run`) so exit codes are never masked by grep/tail pipelines.
- Unknowns are bounded deliberately: the appendix state (Task 7) is an investigation step with decision rules, not a placeholder — the executor reads the vault and applies the stated rule.
- Nothing in this plan touches `src/` — if any task appears to require app-code changes, stop and re-plan; that means an assumption broke.

## Review incorporation (2026-08-09)

External review verified against the vault before incorporation; all seven findings confirmed and applied: Ch7 uses `idAliases` for the detailed H2s (the `splitDeeper` approach collides on path with the summary H3 run — `resolveEntries` matches by path, not occurrence); Ch2's session headings are re-emitted `splitDeeper` H3s under `NEW ADVENTURER CHECKLIST`, not retirements; Task 10 gained the mandatory `release:verify` pre-merge gate; the Ch1 Camp/City promotions are an explicit accepted decision; pipeline-masked verification commands replaced with bare/`--dry-run` invocations; Task 5's ledger check now diffs the preserved 4.1.0 baseline with a per-id disposition audit; Tasks 6–7 stage explicit files after an ownership check.

Second review round (2026-08-09), all four blockers verified and applied: (1) the Ch2 `splitDeeper` entries sit inside the SKIPPED checklist occ-2 subtree — `walkChapter` drops in-skip candidates before consulting `isDeeper`, and the manifest-only alternative (flipping the skip to occ 1) was checked and rejected: both occurrences slug to the shipped `adventurer-new-adventurer-checklist` id and `resolveEntries` cannot disambiguate path collisions, so Task 4 now leads with a TDD walker change rescuing named `splitDeeper` subtrees from skips; (2) the scout CLI uses `resolve()` (Node's `join(cwd, '/abs')` nests absolute paths under the repo) and gained a vault-gated CLI test for `--ledger`; (3) Task 6's preflight narrows to task-relevant paths and forbids restoring unattributed files — the Pre-flight section now carries the worktree inventory naming the two disposable reconnaissance artifacts; (4) `docs/rules/tarot-procedure-audit.md` added to Task 7's files, diff review, and staging. Cleanups: "5 of the 9 chapter sections"; Task 5 reviews the full rules diff from a file, no `head` truncation; Tasks 2/3 verify their chapters in isolation via `walkChapter`+`resolveEntries` (Chapter 2 fails earliest in walk order until Task 4, so full-build checks there were vacuous).

Final plan polish (2026-08-09): the walker TDD test now matches the actual
`walkChapter` contract (`candidate`, not `emitted`) and states the exact red-phase
result; the scout's absolute `--ledger` test uses a unique synthetic sentinel
ledger instead of copying the default, proves the alternate file was read, and
locks the emitted-only loss summary; the expected local/CI test counts are
explicit.
