# Character XP and spell components — implementation

Implemented in the `codex/character-xp-components` worktree. Changes are local and uncommitted; publishing follows the repository's separate PR/release workflow.

## Delivered

- Available XP, named award presets, miscellaneous spending, and owner-only source history.
- The engine and server replay support own-path talent spending (debits XP, masters at the content-pack threshold of 7) and cross-path mentoring (investment separate from remaining prepared uses), but **no sheet UI emits these actions yet**. Shipped in v0.22.0, talent progress is still marked with the free +/− steppers in edit mode and does not touch the XP balance. Wiring talent spending, the Train/mentor form, prepared-use display, and talent corrections into the sheet is the follow-up feature.
- Reasoned balance corrections. (Talent-repair corrections exist in the engine only.)
- Custom and rulebook-linked spell components share the equipment inventory, consume carrying slots, and remain reusable. Descriptions and notes survive Save/Cancel, reloads, shared views, and PDF/Markdown exports.
- Character schema 5 migrates legacy balances to opening balances without inventing historical earnings or deducting old talent investment. Unknown mentored uses require explicit reconciliation.
- Serialized sheet writes, old-schema rejection, and authoritative recovery prevent lost fields, duplicate awards, and autosave/navigation interference.

## Decisions during implementation

The two planned schema increments ship together as version 5. No SQL migration or new dependency is needed. No new Casting Spells reference entry was added: this optional rules-reference expansion is unnecessary for the component editor.

Malformed legacy talent values remain visible. Corrections can repair one record while preserving other unchanged anomalies, but ordinary XP actions remain blocked until all anomalies are reconciled. Above-threshold legacy investment requires a reasoned correction rather than silent clamping. Fractional legacy balances can be corrected into integer balances; chronological ledger summation avoids floating-point regrouping drift after that correction.

The save-recovery path recognizes a committed XP entry by its supplied ID when a response is lost. If saved state cannot be read, further mutations stay blocked until reload succeeds. A navigation-flush response never invalidates the route being left, which avoids cancelling an in-progress destination load.

## Verification

- `npm run check`: zero errors and warnings.
- `npm test`: 129 files, 1,691 tests passed, including local D1 integration tests.
- Full Playwright suite: 94 tests passed before final reconciliation/retry hardening.
- Final focused Playwright run: nine tests passed, covering awards, seventh-XP mastery (via the stepper), rejection retry, offline recovery, overlapping status edits, committed-but-lost response, delayed navigation, custom components, and mobile canonical-component Save/Cancel.
- XP engine coverage: 94.29% statements, 92.88% branches, 100% functions and lines.
- `npm run content:verify:ci`: passed (112 focused content tests); pack 4.4.0 digest verified.
- Final `ADAPTER=cloudflare AUTH_SECRET=local-build-validation-only npm run build`: passed.
- PDF with long component descriptions and multiline notes rendered and visually inspected; mobile sheet screenshot inspected.
- `git diff --check`: clean.

Independent review identified duplicate-award retry, generic correction labels, multiple-invalid-record reconciliation, and above-threshold legacy clamping. All were fixed with regression coverage. Subsequent local verification caught and fixed decimal ledger regrouping and the departing-route invalidation race.

## Release review (v0.22.0)

Codex review before release found the talent-spending UI gap above (owner chose to ship the balance now), plus: the talent picker hid Arête talents (restored); every save used `keepalive`, which browsers cap at ~64 KiB (now size-gated); server replay accepted talent-use on mastered talents and mentoring with unknown prepared uses (now rejected); native v5 creation accepted fractional XP (now rejected); the default award preset was hardcoded (now pack-driven). Later passes also fixed: stale writes now return 409 before ledger replay (was an unrecoverable 400); replayed corrections must land on a whole nonnegative balance; recovery refreshes page data and stays locked if that fails; new mastered talents start with 0 prepared uses.

Deferred:

- Migrate-on-read drops structurally malformed ledger entries; unreachable through app writes, which are Zod-validated.
- Saves over ~60 KB fall back to an ordinary fetch, so a tab close mid-save can drop them (same as v0.21.0 for all saves). Needs a compact XP mutation endpoint.
- The free mastery toggle can master a talent below 7 XP (as on v0.21.0); resolved when talent spending is wired to the ledger.
- Server replay does not block ordinary XP entries while unrelated legacy anomalies remain; the client does.
