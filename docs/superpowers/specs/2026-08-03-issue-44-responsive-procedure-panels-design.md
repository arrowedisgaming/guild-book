# Issue 44 Responsive Procedure Panels Design

## Problem

`TableShell.svelte` currently mounts `CrawlProcedurePanel`, `OraclePanel`, and
the GM-only `CorrectionDialog` twice in its desktop branch and does not mount
them in its mobile branch. Desktop users therefore see duplicate live controls,
while mobile users cannot access the Crawl or Oracle procedure surfaces and
mobile GMs cannot apply an audited correction.

The existing browser coverage does not catch the defect. Procedure and
correction tests use `.first()` to select one of the duplicate desktop mounts,
and the mobile test checks layout behavior without asserting that all procedure
surfaces are present.

## Scope

This change restores layout parity for the three affected surfaces without
changing their behavior, command handlers, authorization rules, state, or
responsive breakpoint.

In scope:

- Render exactly one Crawl panel and one Oracle panel in each responsive
  layout.
- Render exactly one Correction dialog for a GM in each responsive layout.
- Render no Correction dialog for a player in either layout.
- Preserve the mobile table-first DOM order and the existing 320 CSS-pixel and
  200%-zoom overflow guarantees.
- Make browser tests enforce component uniqueness rather than selecting the
  first matching duplicate.

Out of scope:

- Refactoring the procedure panels into a new shared wrapper component.
- Changing `MobileTableDrawers` or moving procedure controls into a drawer.
- Changing procedure visibility, authorization, command dispatch, or
  `matchMedia` behavior.
- Addressing the DevTools-protocol `matchMedia` emulation caveat described in
  issue 44.

## Architecture

Keep `TableShell.svelte` as the composition boundary. In the desktop
`.table-column`, retain one contiguous procedure stack in the existing order:
Challenge, Test of Fate, Group Test, Camp, Crawl, Oracle, then the GM-only
Correction dialog. Remove the earlier malformed duplicate block.

In `.mobile-layout`, add Crawl, Oracle, and the GM-only Correction dialog after
the existing Camp panel and before `MobileTableDrawers`. This mirrors the
desktop procedure order while preserving the required mobile sequence:
`PublicTable` remains the first child, procedure controls remain in the primary
flow, auxiliary phase/log content remains in drawers, and the private hand
remains below them.

Do not create a shared procedure-stack component. The desktop and mobile
branches intentionally compose different surrounding elements, and extracting
all common panels would introduce a large prop-forwarding boundary to remove a
small amount of declarative markup.

## Data and Command Flow

Each retained or added component receives the same props already used on
desktop:

- `CrawlProcedurePanel` and `OraclePanel` receive `role`, `userId`, `session`,
  `challengeRoster`, `procedureTitles`, and `onSendFiniteCommand`.
- `CorrectionDialog` receives `session`, `events`, and
  `onSendCorrectionCommand`, and remains inside `role === 'gm'`.

No component owns new state and no new command path is introduced. Every action
continues through the callback supplied by the route-level campaign session
store. Responsive branches are mutually exclusive, so exactly one live copy of
each applicable surface exists at a time.

## Error Handling and Privacy

Existing panel-level pending and error behavior remains unchanged. The shell
continues to surface rejected commands through the existing callback results.

The correction surface stays GM-only in the template, and finite procedure
panels continue to render exclusively from the role-specific session
projection and legal-command set. No private data is moved into shared markup,
attributes, or a new component boundary.

## Testing

Extend `tests/e2e/campaign-mobile.spec.ts` using its existing GM/player campaign
fixture:

- On the initial desktop GM table, assert exactly one
  `finite-panel-crawl`, one `finite-panel-cross-phase`, and one
  `open-correction` control.
- On the 320px player table, assert exactly one Crawl and Oracle panel and zero
  correction controls.
- Resize the GM page to 320px, reload so the component initializes from the
  narrow `matchMedia` result, and assert exactly one Crawl panel, one Oracle
  panel, one correction control, and the mobile drawers.
- Keep the existing DOM-order, keyboard, hand-scroller, 320px overflow, and
  200%-zoom assertions to prove that the added controls do not regress the
  responsive contract.

Update `tests/e2e/exploration-tarot.spec.ts` and
`tests/e2e/session-history.spec.ts` to stop using `.first()` for the affected
panel and correction locators. Playwright strictness will then fail those
functional workflows if duplicate mounts return.

The focused verification gate is:

```bash
npx playwright test tests/e2e/campaign-mobile.spec.ts tests/e2e/exploration-tarot.spec.ts tests/e2e/session-history.spec.ts
npm run check
npm test
```

The first command proves responsive composition and the existing finite and
correction workflows. The latter commands catch Svelte/TypeScript and broader
unit/integration regressions.

## Success Criteria

- Desktop and mobile render one Crawl panel and one Oracle panel whenever their
  existing visibility conditions allow them to render.
- A GM has one correction control on desktop and mobile; a player has none.
- Existing finite-procedure and correction workflows pass without `.first()`
  masking duplicate DOM nodes.
- The existing mobile DOM-order, keyboard, horizontal-overflow, and zoom checks
  remain green.
- No engine, schema, server, content-pack, or database files change.
