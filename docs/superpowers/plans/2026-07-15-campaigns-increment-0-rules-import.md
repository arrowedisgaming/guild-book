# Campaigns Increment 0: Tarot Procedure Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an audited, deterministic, content-pack-driven inventory of every in-session tarot procedure required by campaign play.

**Architecture:** A manifest names source Markdown headings and normalized procedure records. A Node importer extracts those records into generated JSON, while Zod validates both build output and Worker-bundled runtime imports. An audit document is generated from the same manifest so scope and implementation cannot drift independently.

**Tech Stack:** Node ESM scripts, local Markdown source under ignored `assets-src/HMTW_md/`, JSON, TypeScript, Zod, Vitest.

## Global Constraints

- Start from the approved procedure coverage in specification sections 8–9; do not infer preparation tooling back into v1.
- Include Chapters 6–9 and targeted tarot-bearing sections in Chapters 1, 4, 5, 10, 11, 13, and live Appendix D material.
- Classify each discovered occurrence as `supported-v1`, `deferred-preparation`, or `not-applicable-non-tarot`.
- Keep Doomsaying, Strange Communions, and As Above, So Below; defer the Job Board and other GM preparation generators.
- Retain the game's flat 50% manual non-tarot choice as a typed manual step; do not simulate it with a card draw.
- Generated rules content may reproduce only text allowed by the repository licence policy.
- A generated runtime session snapshot must remain below D1's 2 MB row limit.

---

### Task 1: Define the procedure content contract

**Files:**
- Modify: `src/lib/types/content-pack.ts`
- Modify: `src/lib/schemas/content-pack.schema.ts`
- Modify: `static/content-packs/hmtw/index.json`
- Test: `tests/unit/content-pack.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add assertions that the bundled pack declares `tarotProcedures`, validates every record, and has unique IDs:

```ts
import { getTarotProcedures } from '$lib/server/content/loader';

it('loads a unique, versioned tarot procedure catalog', () => {
  const file = getTarotProcedures();
  expect(file.schemaVersion).toBe(1);
  expect(file.procedures.length).toBeGreaterThan(0);
  expect(new Set(file.procedures.map((p) => p.id)).size).toBe(file.procedures.length);
  expect(file.procedures.every((p) => p.steps.length > 0)).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/content-pack.test.ts`

Expected: FAIL because `getTarotProcedures` and the manifest file key do not exist.

- [ ] **Step 3: Add the typed contract**

Add these exported types to `src/lib/types/content-pack.ts`:

```ts
export type TarotProcedurePhase = 'crawl' | 'challenge' | 'camp' | 'city' | 'cross-phase';
export type TarotProcedureScope =
  | 'supported-v1'
  | 'deferred-preparation'
  | 'not-applicable-non-tarot';

export type TarotOperation =
  | 'draw'
  | 'deal'
  | 'play'
  | 'place-facedown'
  | 'reveal'
  | 'discard'
  | 'transfer'
  | 'select-from-discard'
  | 'reorder-top'
  | 'mulligan'
  | 'manual-choice';

export interface TarotProcedureStepDefinition {
  id: string;
  actor: 'gm' | 'player' | 'system';
  operation: TarotOperation;
  count?: number;
  visibility: 'public' | 'actor-private' | 'recipient-private';
  completion: 'automatic' | 'actor-confirmed' | 'gm-confirmed';
}

export interface TarotProcedureDefinition {
  id: string;
  title: string;
  phase: TarotProcedurePhase;
  scope: TarotProcedureScope;
  source: { file: string; heading: string };
  ruleEntryIds: string[];
  steps: TarotProcedureStepDefinition[];
  modifierIds: string[];
}

export interface TarotProceduresFile {
  schemaVersion: 1;
  procedures: TarotProcedureDefinition[];
}
```

Add required `tarotProcedures: string` to `ContentPackFiles`, mirror the union with Zod enums, and add `tarotProceduresFileSchema`. Add `"tarotProcedures": "tarot-procedures.json"` to `index.json` without changing the pack version yet; the generated-content task performs the version bump.

- [ ] **Step 4: Run the focused type and test checks**

Run: `npm run check`

Expected: PASS after all TypeScript/Zod definitions agree. The unit test may still fail because no generated file or loader exists.

- [ ] **Step 5: Commit the contract**

```bash
git add src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json tests/unit/content-pack.test.ts
git commit -m "feat(content): define tarot procedure catalog"
```

### Task 2: Build the source manifest and coverage audit

**Files:**
- Create: `scripts/content-import/manifest/tarot-procedures-md.json`
- Create: `scripts/content-import/md-procedures.mjs`
- Create: `docs/rules/tarot-procedure-audit.md`
- Test: `tests/unit/tarot-procedure-audit.test.ts`

- [ ] **Step 1: Write the failing audit completeness test**

Create `tests/unit/tarot-procedure-audit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import manifest from '../../scripts/content-import/manifest/tarot-procedures-md.json';

const required = [
  'test-of-fate',
  'group-test',
  'challenge-round',
  'challenge-black-honey',
  'challenge-stun',
  'challenge-brainfever',
  'challenge-counsel',
  'challenge-guardian-angel',
  'challenge-aim',
  'challenge-shield-initiative',
  'camp-high-chant',
  'camp-leeches',
  'camp-watch',
  'crawl-area-sense',
  'overland-travel',
  'test-augury',
  'city-doomsaying',
  'city-strange-communions',
  'city-as-above-so-below',
  'oracle-maleficence',
  'oracle-malediction',
  'oracle-random-totem',
  'gm-twist',
  'denizen-disposition'
] as const;

describe('tarot procedure audit manifest', () => {
  it('classifies every required v1 procedure exactly once', () => {
    const ids = manifest.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of required) expect(ids).toContain(id);
  });

  it('keeps preparation tools out of supported v1 scope', () => {
    const jobBoard = manifest.entries.find((entry) => entry.id === 'city-job-board');
    expect(jobBoard?.scope).toBe('deferred-preparation');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-procedure-audit.test.ts`

Expected: FAIL because the JSON manifest is absent.

- [ ] **Step 3: Author every manifest entry from the local Markdown**

Use this exact record shape for every tarot-bearing occurrence found by searching the selected chapters:

```json
{
  "id": "camp-high-chant",
  "title": "High Chant",
  "phase": "camp",
  "scope": "supported-v1",
  "source": {
    "file": "08 - Chapter 8 - The Camp Phase.md",
    "heading": "High Chant"
  },
  "ruleEntryIds": ["camp-high-chant"],
  "modifierIds": ["high-chant-transfer"],
  "steps": [
    {
      "id": "transfer-card",
      "actor": "player",
      "operation": "transfer",
      "visibility": "recipient-private",
      "completion": "actor-confirmed"
    }
  ]
}
```

Search the Markdown with:

```bash
rg -n -i "tarot|arcana|card|draw|deal|discard|hand|fool|doom|initiative|oracle|augury|chant|leeches" assets-src/HMTW_md
```

For each match, record its source heading and one of the three scope statuses. The importer calls `extractSection` for every declared file/heading so renamed or missing source headings fail the local build. It also verifies that every `ruleEntryId` exists in the generated rules manifest/output. The manifest includes unsupported audit-only entries with an empty `steps` array; the generated runtime JSON filters those out, while the audit retains them.

- [ ] **Step 4: Implement deterministic audit rendering**

In `md-procedures.mjs`, sort entries by source file, source heading, then ID; render the audit with a fixed header and one Markdown table row per manifest entry. Escape pipe characters in titles/headings. Do not include timestamps or local absolute paths.

The script interface is:

```js
export function compileProcedureContent(entries) {
  return {
    schemaVersion: 1,
    procedures: entries
      .filter((entry) => entry.scope === 'supported-v1')
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

export function renderAudit(entries) {
  const rows = [...entries]
    .sort((a, b) =>
      a.source.file.localeCompare(b.source.file) ||
      a.source.heading.localeCompare(b.source.heading) ||
      a.id.localeCompare(b.id)
    )
    .map((entry) =>
      `| ${entry.id} | ${entry.title.replaceAll('|', '\\|')} | ${entry.scope} | ${entry.source.file} — ${entry.source.heading.replaceAll('|', '\\|')} |`
    );
  return ['# Tarot Procedure Audit', '', '| ID | Procedure | Scope | Source |', '|---|---|---|---|', ...rows, ''].join('\n');
}
```

The executable writes both generated destinations in normal mode and compares byte-for-byte in `--check` mode, following `md-rules.mjs` conventions.

- [ ] **Step 5: Run and inspect the audit**

Run: `node scripts/content-import/md-procedures.mjs`

Expected: creates `static/content-packs/hmtw/tarot-procedures.json` and `docs/rules/tarot-procedure-audit.md` with deterministic ordering.

Run: `npm test -- tests/unit/tarot-procedure-audit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the audited source map**

```bash
git add scripts/content-import/manifest/tarot-procedures-md.json scripts/content-import/md-procedures.mjs docs/rules/tarot-procedure-audit.md tests/unit/tarot-procedure-audit.test.ts static/content-packs/hmtw/tarot-procedures.json
git commit -m "feat(content): audit in-session tarot procedures"
```

### Task 3: Bundle and validate procedure content

**Files:**
- Modify: `src/lib/server/content/loader.ts`
- Modify: `tests/unit/content-pack.test.ts`
- Test: `tests/unit/tarot-procedures.test.ts`

- [ ] **Step 1: Add failing semantic validation tests**

Create `tests/unit/tarot-procedures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';

describe('tarot procedure semantics', () => {
  it('uses unique step ids and only supported runtime entries', () => {
    for (const procedure of getTarotProcedures().procedures) {
      expect(procedure.scope).toBe('supported-v1');
      expect(new Set(procedure.steps.map((step) => step.id)).size).toBe(procedure.steps.length);
      expect(procedure.steps.length).toBeGreaterThan(0);
    }
  });

  it('does not replace the manual 50 percent choice with a draw', () => {
    const manual = getTarotProcedures().procedures
      .flatMap((procedure) => procedure.steps)
      .find((step) => step.id === 'flat-fifty-percent-choice');
    expect(manual?.operation).toBe('manual-choice');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-procedures.test.ts`

Expected: FAIL because the loader does not export the catalog.

- [ ] **Step 3: Add the Worker-safe static import and cache**

In `src/lib/server/content/loader.ts`, import the generated JSON statically and expose:

```ts
import type { TarotProceduresFile } from '$lib/types/content-pack';
import { tarotProceduresFileSchema } from '$lib/schemas/content-pack.schema';
import tarotProceduresJson from '../../../../static/content-packs/hmtw/tarot-procedures.json';

let cachedTarotProcedures: TarotProceduresFile | null = null;

export function getTarotProcedures(): TarotProceduresFile {
  if (!cachedTarotProcedures) {
    cachedTarotProcedures = parseOrThrow(
      tarotProceduresFileSchema,
      tarotProceduresJson,
      'tarot-procedures.json'
    );
  }
  return cachedTarotProcedures;
}
```

Add `tarotProcedures: getTarotProcedures()` only to server-side bundles that need session startup; do not add it to the character wizard payload.

- [ ] **Step 4: Run content and unit checks**

Run: `npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedures.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit runtime loading**

```bash
git add src/lib/server/content/loader.ts tests/unit/content-pack.test.ts tests/unit/tarot-procedures.test.ts
git commit -m "feat(content): load tarot procedure catalog"
```

### Task 4: Make content generation and version drift enforceable

**Files:**
- Modify: `package.json`
- Modify: `scripts/content-import/pack.mjs`
- Create: `scripts/content-import/verify-pack-version.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `static/content-packs/hmtw/index.json`
- Test: `tests/unit/content-build.test.ts`

- [ ] **Step 1: Add failing deterministic-build and size tests**

Create `tests/unit/content-build.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('generated session content', () => {
  it('fits within one D1 row with safety margin', () => {
    const bytes = readFileSync('static/content-packs/hmtw/tarot-procedures.json').byteLength;
    expect(bytes).toBeLessThan(1_900_000);
  });

  it('declares the post-import pack version', () => {
    const index = JSON.parse(readFileSync('static/content-packs/hmtw/index.json', 'utf8'));
    expect(index.version).not.toBe('1.0.0');
  });
});
```

- [ ] **Step 2: Run the test to verify the version assertion fails**

Run: `npm test -- tests/unit/content-build.test.ts`

Expected: FAIL while `index.json` is still version `1.0.0`.

- [ ] **Step 3: Wire build and check scripts**

Change scripts to run the procedure compiler and version verifier:

```json
{
  "content:build": "node scripts/content-import/md-inject.mjs && node scripts/content-import/md-rules.mjs && node scripts/content-import/md-spells.mjs && node scripts/content-import/md-procedures.mjs",
  "content:verify": "node scripts/content-import/md-inject.mjs --check && node scripts/content-import/md-rules.mjs --check && node scripts/content-import/md-spells.mjs --check && node scripts/content-import/md-procedures.mjs --check && node scripts/content-import/verify-pack-version.mjs"
}
```

`verify-pack-version.mjs` computes SHA-256 over the generated content files in manifest-key order and compares it with a committed `contentDigest` field in `index.json`. Add that required field to `GuildBookContentPack` and `contentPackSchema` as a 64-character lowercase hexadecimal string. The verifier exits nonzero if current bytes do not match the digest. When `CONTENT_BASE_REF` is supplied, it reads the base revision's `index.json` with `git show`; if the digest changed but the semantic version did not, it exits nonzero. Use Node `createHash` and `execFileSync('git', ['show', ...])`; do not add a dependency or construct a shell command.

The digest input is exactly:

```js
const orderedFiles = Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b));
for (const [key, file] of orderedFiles) {
  hash.update(key);
  hash.update('\0');
  hash.update(readFileSync(join(packDir, file)));
  hash.update('\0');
}
```

- [ ] **Step 4: Bump the content pack and record its digest**

Set `index.json` to the next minor pack version because procedure capability is additive, regenerate the digest with an explicit `--write` mode, then make normal verification read-only:

```bash
node scripts/content-import/verify-pack-version.mjs --write
npm run content:verify
```

Expected: PASS and `index.json` contains a 64-character lowercase `contentDigest`.

Add `md-procedures.mjs --check-generated`, which renders runtime JSON/audit from the committed manifest without opening ignored Markdown, while the normal `--check` also validates every local source heading. Add:

```json
{
  "content:verify:ci": "node scripts/content-import/md-procedures.mjs --check-generated && node scripts/content-import/verify-pack-version.mjs && npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts tests/unit/content-build.test.ts"
}
```

Update both CI checkout steps to use full history, then add this source-free validation to the `check` job after `npm ci`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- name: Verify generated content and pack version
  run: npm run content:verify:ci
  env:
    CONTENT_BASE_REF: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
```

CI must not require or download the ignored copyrighted Markdown source. `verify-pack-version.mjs` treats an absent/all-zero base on a repository's first push as current-integrity-only validation and prints that degraded comparison explicitly.

- [ ] **Step 5: Run the complete increment gate**

Run:

```bash
npm run content:build
npm run content:verify
npm test -- tests/unit/content-pack.test.ts tests/unit/tarot-procedure-audit.test.ts tests/unit/tarot-procedures.test.ts tests/unit/content-build.test.ts
npm run check
npm test
```

Expected: every command exits 0; a second `npm run content:build` produces no diff.

- [ ] **Step 6: Commit Increment 0**

```bash
git add package.json scripts/content-import/pack.mjs scripts/content-import/verify-pack-version.mjs src/lib/types/content-pack.ts src/lib/schemas/content-pack.schema.ts static/content-packs/hmtw/index.json tests/unit/content-build.test.ts .github/workflows/ci.yml
git commit -m "build(content): enforce deterministic procedure imports"
```

## Increment 0 Completion Record

Record the content-pack version, digest, generated procedure count, each classification count, runtime JSON byte size, and verification command output in the implementation PR. Do not begin Increment 0.5 until every required in-session rule has a manifest classification.
