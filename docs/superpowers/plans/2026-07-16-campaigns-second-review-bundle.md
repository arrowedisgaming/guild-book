# Campaigns Second Review Fix Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish, verify, and commit the existing second-adversarial-review correction bundle without beginning any later campaign work.

**Architecture:** Preserve the current manifest-driven content pipeline and the standalone pure tarot resolution engine. Make only the metadata and documentation-consistency edits needed to turn the existing working tree into one verified commit.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript, Vitest, Playwright, JSON content manifests, Node content-import scripts.

## Global Constraints

- Stop after the correction bundle commit.
- Do not add `invokedFrom` or re-audit the procedure catalog.
- Do not resolve the Fool drawn-versus-played contradiction.
- Do not begin Campaign Foundation or create session/campaign code.
- Keep generated rules, procedures, and audit files derived from their manifests.
- Use content-pack version `2.3.0` for this additive corrective content change.
- Commit the complete correction bundle with `fix(tarot): address second adversarial review findings`.

---

### Task 1: Complete and commit the correction bundle

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-campaigns-increment-3-challenge.md`
- Modify: `static/content-packs/hmtw/index.json`
- Verify existing changes in:
  - `docs/rules/tarot-procedure-audit.md`
  - `docs/superpowers/2026-07-16-campaigns-status-and-handover.md`
  - `docs/superpowers/specs/2026-07-15-campaigns-shared-tarot-design.md`
  - `scripts/content-import/manifest/rules-md.json`
  - `scripts/content-import/manifest/tarot-procedures-md.json`
  - `scripts/content-import/md-lib.mjs`
  - `src/lib/components/tarot/TestOfFate.svelte`
  - `static/content-packs/hmtw/rules.json`
  - `static/content-packs/hmtw/tarot-procedures.json`
  - `tests/e2e/deck-test-of-fate.spec.ts`
  - `tests/unit/rules-coverage.test.ts`

**Interfaces:**
- Consumes: the existing manifest-driven generators and `verify-pack-version.mjs`.
- Produces: content pack `2.3.0` with a matching digest and one committed review-fix bundle.

- [ ] **Step 1: Align the Challenge plan's enemy-type fields**

In `ChallengeConfig`, replace:

```ts
perEnemy: number;
```

with:

```ts
perEnemyType: number;
```

Keep the state field:

```ts
enemyFacts: Array<{ id: string; size: string; threat: string; typeIds: string[] }>;
```

Calculate unique enemy types with:

```ts
const enemyTypeCount = new Set(enemies.flatMap((enemy) => enemy.typeIds)).size;
```

and use:

```ts
enemyTypeCount * config.gmHandFormula.perEnemyType
```

Also change the stale note after the modifier expectation from:

```text
the absence of `shield-initiative`
```

to:

```text
the restored `challenge-guard` modifier
```

- [ ] **Step 2: Check documentation consistency**

Run:

```bash
rg -n 'perEnemy\b|e\.typeId\b|absence of .*shield-initiative|no such mechanic exists' \
  docs/superpowers/plans/2026-07-15-campaigns-increment-3-challenge.md \
  docs/superpowers/specs/2026-07-15-campaigns-shared-tarot-design.md
```

Expected: no stale executable field names or current assertions that Guard does
not exist. Historical amendment text that explicitly says the earlier assertion
was wrong may remain.

- [ ] **Step 3: Record the content-pack version**

In `static/content-packs/hmtw/index.json`, change:

```json
"version": "2.2.0"
```

to:

```json
"version": "2.3.0"
```

- [ ] **Step 4: Regenerate the content digest**

Run:

```bash
node scripts/content-import/verify-pack-version.mjs --write
```

Expected: exits 0 and prints `Recorded contentDigest` followed by a 64-character lowercase hexadecimal digest.

- [ ] **Step 5: Verify generated content and code**

Run:

```bash
git diff --check
npm run content:verify
npm run check
npm test
```

Expected:

- `git diff --check` exits 0.
- All generated collections report `0 drifted`.
- The content digest matches pack version `2.3.0`.
- `svelte-check` reports 0 errors and 0 warnings.
- Vitest reports 21 passing files and 231 passing tests.

- [ ] **Step 6: Attempt the focused browser suite**

Run:

```bash
npx playwright test tests/e2e/deck-test-of-fate.spec.ts
```

Expected when the configured web server can build: the focused suite passes.

If `npm run build` fails with the already documented network-dependent
`ETIMEDOUT`, record that exact failure as an environmental verification gap.
Do not modify Playwright configuration or application build behavior in this
bundle.

- [ ] **Step 7: Inspect the final commit scope**

Run:

```bash
git status --short
git diff --stat HEAD
git diff --check
```

Expected: only the approved correction-bundle files are modified or untracked,
and there are no whitespace errors.

- [ ] **Step 8: Commit the correction bundle**

Stage the exact files reported by `git status --short`, excluding this
implementation-plan document if it has already been committed separately.

Run:

```bash
git commit -m "fix(tarot): address second adversarial review findings"
```

Expected: one successful commit containing the correction bundle.

- [ ] **Step 9: Verify the committed state and stop**

Run:

```bash
git status --short --branch
git show --stat --oneline --summary HEAD
```

Expected: the working tree is clean, the latest commit is the correction bundle,
and no `invokedFrom`, procedure re-audit, or Campaign Foundation work has begun.
