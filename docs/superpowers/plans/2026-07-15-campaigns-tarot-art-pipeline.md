# Campaigns Tarot Artwork Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the authorized local 78-face/2-back Rider–Waite–Smith set into deterministic, responsive, uncropped production assets mapped to stable content-pack card IDs.

**Architecture:** Ignored source PNGs remain under `assets-src/tarot/rwsa`. A build script applies an explicit source-filename-to-card-ID map, validates completeness and dimensions, emits size variants under `static/tarot/rwsa`, and writes a hash/dimension/licence manifest. UI resolves images only from authorized projected card IDs; hidden cards resolve a fixed back without receiving a face ID.

**Tech Stack:** Node ESM, Sharp as a development build dependency, SHA-256, AVIF/WebP, Svelte 5, Vitest, Playwright visual/DOM assertions.

## Global Constraints

- The user has confirmed permission for the 80-image set; do not reopen the permission decision in this plan.
- Source PNGs stay ignored and are never served, copied verbatim to production, or committed.
- Exactly 78 stable face IDs and two named backs must map exactly once. Missing, duplicate, unexpected, or case-mismatched source files fail the build.
- Preserve the complete artwork: use contain/fitted dimensions with no crop, face-up rotation, filter, recolor, generated frame, or generative edit.
- Production output includes responsive AVIF and WebP. Do not emit source PNGs.
- The card component uses an Archival Frame: full uncropped artwork, neutral mat, slim label footer, and an enlargement dialog.
- Hidden card rendering must not construct, preload, serialize, or mention its face URL or identity.

---

### Task 1: Define the explicit 80-file source map

**Files:**
- Create: `scripts/tarot-art/source-map.mjs`
- Create: `tests/unit/tarot-art-map.test.ts`

- [ ] **Step 1: Write the failing map completeness test**

```ts
import { describe, expect, it } from 'vitest';
import { FACE_SOURCE_MAP, BACK_SOURCE_MAP } from '../../scripts/tarot-art/source-map.mjs';
import { buildPlayerDeck, buildMajorDeck } from '$lib/engine/tarot-deck';
import { getContentPack } from '$lib/server/content/loader';

describe('RWS artwork map', () => {
  it('maps every stable card id exactly once', () => {
    const config = getContentPack().tarot;
    const expected = [...buildPlayerDeck(config), ...buildMajorDeck(config)].map((card) => card.id).sort();
    const actual = Object.keys(FACE_SOURCE_MAP).sort();
    expect(actual).toEqual(expected);
    expect(new Set(Object.values(FACE_SOURCE_MAP)).size).toBe(78);
  });

  it('maps exactly two distinct backs', () => {
    expect(Object.keys(BACK_SOURCE_MAP).sort()).toEqual(['ornate', 'plain']);
    expect(new Set(Object.values(BACK_SOURCE_MAP)).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-art-map.test.ts`

Expected: FAIL because `source-map.mjs` is absent.

- [ ] **Step 3: Author the deterministic mapping**

Major mapping is explicit (`fool` → `RWSa-T-00.png` through `world` → `RWSa-T-21.png`). Each suit uses the existing stable IDs and these source suffixes:

```js
export const RANK_SOURCE_SUFFIX = Object.freeze({
  i: '0A',
  ii: '02',
  iii: '03',
  iv: '04',
  v: '05',
  vi: '06',
  vii: '07',
  viii: '08',
  ix: '09',
  x: '10',
  page: 'J1',
  knight: 'J2',
  queen: 'QU',
  king: 'KI'
});

export const SUIT_SOURCE_PREFIX = Object.freeze({
  swords: 'S',
  pentacles: 'P',
  cups: 'C',
  wands: 'W'
});

export const BACK_SOURCE_MAP = Object.freeze({
  ornate: 'RWSa-X-BA.png',
  plain: 'RWSa-X-RL.png'
});
```

Build the minor filename map from frozen suit/rank constants but export the final stable-ID object. Keep the 22-major array explicit so name/number ordering mistakes are reviewable.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/unit/tarot-art-map.test.ts`

Expected: PASS.

```bash
git add scripts/tarot-art/source-map.mjs tests/unit/tarot-art-map.test.ts
git commit -m "feat(tarot-art): map authorized RWS images"
```

### Task 2: Build deterministic responsive assets and manifest

**Files:**
- Create: `scripts/tarot-art/build.mjs`
- Create: `scripts/tarot-art/verify.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `static/tarot/rwsa/tarot-art.json`
- Create: generated image files under `static/tarot/rwsa/faces/`
- Create: generated image files under `static/tarot/rwsa/backs/`
- Test: `tests/unit/tarot-art-build.test.ts`

- [ ] **Step 1: Add Sharp and failing build-output tests**

Run: `npm install --save-dev sharp`

Then create tests that read the committed manifest:

```ts
const manifest = JSON.parse(readFileSync('static/tarot/rwsa/tarot-art.json', 'utf8'));

expect(manifest.schemaVersion).toBe(1);
expect(manifest.collectionId).toBe('rwsa');
expect(Object.keys(manifest.faces)).toHaveLength(78);
expect(Object.keys(manifest.backs)).toHaveLength(2);
for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
  expect(asset.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(asset.width).toBeGreaterThan(0);
  expect(asset.height).toBeGreaterThan(asset.width);
  expect(asset.variants.map((v) => v.format).sort()).toEqual(['avif', 'avif', 'avif', 'webp', 'webp', 'webp']);
  expect(asset.variants.every((v) => !v.path.endsWith('.png'))).toBe(true);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/tarot-art-build.test.ts`

Expected: FAIL because the manifest is absent.

- [ ] **Step 3: Implement strict source inventory validation**

`build.mjs` reads `assets-src/tarot/rwsa`, compares the sorted `.png` basename set with the exact 80 mapped basenames, and exits nonzero listing missing and unexpected names. It uses `sharp(input).metadata()` to require portrait orientation, records original width/height/hash, and rejects animated/multipage input.

- [ ] **Step 4: Emit fixed-width uncropped variants**

For widths 240, 480, and 960, emit both formats using `fit: 'inside'` and `withoutEnlargement: true`:

```js
async function writeVariant(input, output, width, format) {
  const pipeline = sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width, fit: 'inside', withoutEnlargement: true });
  if (format === 'avif') await pipeline.avif({ quality: 62, effort: 6 }).toFile(output);
  else await pipeline.webp({ quality: 82, effort: 6 }).toFile(output);
}
```

Output paths use stable IDs only, URL-encoded by construction:

- `faces/<card-id>-240.avif`
- `faces/<card-id>-240.webp`
- same at 480/960
- `backs/<back-id>-<width>.<format>`

Sort manifest keys and variants, use relative leading-slash public paths, include output byte size/hash/dimensions, and write no build timestamp.

- [ ] **Step 5: Add licence/provenance metadata**

Manifest includes:

```json
{
  "schemaVersion": 1,
  "collectionId": "rwsa",
  "title": "Rider–Waite–Smith tarot",
  "sourceSet": "Locally supplied authorized 80-image set",
  "permissionBasis": "Project owner confirmed permission for this set",
  "processing": "Uncropped responsive AVIF/WebP derivatives",
  "faces": {},
  "backs": {}
}
```

Do not claim public-domain status more broadly than the user-approved source set metadata establishes.

- [ ] **Step 6: Implement read-only verification mode**

`verify.mjs` rebuilds to a temporary directory, compares manifest bytes plus every output hash/path, validates no PNG in `static/tarot/rwsa`, and deletes only its own temporary output. Wire:

```json
{
  "tarot-art:build": "node scripts/tarot-art/build.mjs",
  "tarot-art:verify": "node scripts/tarot-art/verify.mjs"
}
```

- [ ] **Step 7: Generate, verify, and commit**

Run:

```bash
npm run tarot-art:build
npm run tarot-art:verify
npm test -- tests/unit/tarot-art-map.test.ts tests/unit/tarot-art-build.test.ts
```

Expected: every command exits 0; output includes 480 derivative files plus one manifest and no PNGs.

```bash
git add package.json package-lock.json scripts/tarot-art static/tarot/rwsa tests/unit/tarot-art-build.test.ts
git commit -m "build(tarot-art): generate responsive RWS assets"
```

### Task 3: Add a typed runtime artwork resolver

**Files:**
- Create: `src/lib/types/tarot-art.ts`
- Create: `src/lib/schemas/tarot-art.schema.ts`
- Create: `src/lib/tarot/art.ts`
- Test: `tests/unit/tarot-art.test.ts`

- [ ] **Step 1: Write failing resolver tests**

```ts
expect(getTarotFaceSources('fool')).toMatchObject({
  avifSrcset: expect.stringContaining('/tarot/rwsa/faces/fool-240.avif 240w'),
  webpSrcset: expect.stringContaining('/tarot/rwsa/faces/fool-240.webp 240w')
});
expect(getTarotBackSources('ornate').avifSrcset).toContain('/tarot/rwsa/backs/ornate-240.avif');
expect(() => getTarotFaceSources('not-a-card')).toThrow(/unknown tarot art id/i);
```

- [ ] **Step 2: Validate the manifest at import**

Statically import `tarot-art.json`, parse once with Zod, and expose only:

```ts
export interface TarotImageSources {
  avifSrcset: string;
  webpSrcset: string;
  fallbackWebp: string;
  width: number;
  height: number;
}

export function getTarotFaceSources(cardId: string): TarotImageSources;
export function getTarotBackSources(backId?: 'ornate' | 'plain'): TarotImageSources;
```

The resolver accepts an already authorized face ID; it has no session state or visibility logic.

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/unit/tarot-art.test.ts`

Expected: PASS.

```bash
git add src/lib/types/tarot-art.ts src/lib/schemas/tarot-art.schema.ts src/lib/tarot/art.ts tests/unit/tarot-art.test.ts
git commit -m "feat(tarot-art): resolve typed responsive sources"
```

### Task 4: Render the Archival Frame without privacy leaks

**Files:**
- Modify: `src/lib/components/tarot/TarotCard.svelte`
- Create: `src/lib/components/tarot/TarotCardImage.svelte`
- Create: `src/lib/components/tarot/TarotCardDialog.svelte`
- Modify: every `TarotCard` caller found by `rg "<TarotCard" src`
- Modify: `src/routes/licensing/+page.svelte`
- Test: `tests/e2e/tarot-art.spec.ts`
- Test: `tests/e2e/shared-table-privacy.spec.ts`

- [ ] **Step 1: Write failing DOM and layout tests**

For a face-up card, assert `<picture>` has AVIF/WebP sources, `object-fit: contain`, full card label footer, intrinsic ratio, and an enlargement button/dialog. For a hidden player card viewed by GM, assert HTML/DOM/network request URLs do not contain its face ID and contain only the fixed back paths.

- [ ] **Step 2: Split face-up and face-down render branches**

```svelte
{#if faceDown || !card}
  <TarotCardImage sources={getTarotBackSources('ornate')} alt="Face-down card" />
{:else}
  <TarotCardImage sources={getTarotFaceSources(card.id)} alt={card.label} />
  <footer class="label">{card.label}</footer>
{/if}
```

Do not compute `getTarotFaceSources(card.id)` before the conditional. Hidden callers pass no `card` object. Use `<picture>`, `sizes`, lazy loading outside the active hand, explicit width/height, `object-fit: contain`, and neutral mat/background tokens. The dialog uses the 960-width sources and returns focus to its trigger.

- [ ] **Step 3: Add compact/list fallback without crop**

At small size, the complete image remains visible; label footer may use smaller type but may not overlay or cut the art. If CSS container is shorter than the natural ratio, let the component grow instead of applying `cover`.

Update the licensing page with the manifest's exact collection title, project-owner-confirmed permission basis, and derivative-processing note. Do not make a broader public-domain claim than the approved source set supports.

- [ ] **Step 4: Run full artwork/privacy verification**

Run:

```bash
npm run tarot-art:verify
npm test -- tests/unit/tarot-art-map.test.ts tests/unit/tarot-art-build.test.ts tests/unit/tarot-art.test.ts
npm run check
npx playwright test tests/e2e/tarot-art.spec.ts tests/e2e/shared-table-privacy.spec.ts
ADAPTER=cloudflare npm run build
```

Expected: every command exits 0; 78 faces render by ID; hidden canary face URL is never requested or serialized.

- [ ] **Step 5: Commit the artwork UI**

```bash
git add src/lib/components/tarot src/routes/licensing/+page.svelte tests/e2e/tarot-art.spec.ts tests/e2e/shared-table-privacy.spec.ts
git commit -m "feat(tarot-art): render uncropped archival cards"
```

Add any additional modified `TarotCard` caller paths shown by `git status --short` explicitly; never stage the whole `src` tree.

## Artwork Completion Record

Attach source inventory counts, manifest/output hashes, dimensions, derivative byte totals, representative desktop/mobile screenshots, and the hidden-face network/DOM privacy assertion. This plan must complete before Increment 5 public enablement.
