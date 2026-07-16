# Campaigns Second Review Fix Bundle — Design

**Status:** Approved in conversation on 2026-07-16

## Goal

Finish and commit the existing uncommitted changes on
`fix/campaigns-second-review-findings` as a coherent correction bundle. Stop
after that commit. Do not begin the `invokedFrom` contract, procedure re-audit,
Campaign Foundation, or any other feature work.

## Scope

The bundle includes the changes already present in the working tree:

- Restore the real Guard rule and its shield Initiative replacement procedure,
  modifier, specification text, and Increment 3 plan coverage.
- Import the previously omitted miscellaneous-actions rule.
- Correct the Increment 3 GM hand calculation to count enemy types rather than
  individual enemies.
- Preserve spaces when the prose importer removes HTML `<br>` elements, with a
  regression test against welded clauses.
- Lock Test of Fate declarations after the initial card becomes visible.
- Rewrite Test of Fate browser tests so favor, disfavor, and Resolve are
  declared before drawing, and assert that declarations remain locked.
- Retain the status and handover document describing the review findings,
  failure modes, and later recommended work.

Only two additional corrections are permitted while completing the bundle:

1. Align the Increment 3 pseudocode and state shape on the field names used for
   enemy types and the per-enemy-type formula parameter.
2. Bump the HMTW content-pack minor version and refresh its content digest so
   the generated-content integrity gate passes.

## Non-goals

This bundle does not:

- Add `invokedFrom` to the procedure contract.
- Re-audit or remodel the outstanding procedure and modifier findings.
- Resolve the rulebook contradiction about whether drawing or playing the Fool
  triggers the Challenge reshuffle.
- Add campaign or shared-session persistence, routes, reducers, or UI.
- Change the E2E web-server architecture or solve its network-dependent build
  behavior.

## Data and documentation consistency

Generated content continues to be authored through the committed manifests and
content-import scripts. Generated JSON and the generated tarot procedure audit
must match fresh local extraction from the rulebook vault.

The content change is additive and corrective, so the pack version moves from
`2.2.0` to `2.3.0`. The digest is regenerated only after the manifests and
generated outputs are stable.

The Increment 3 example uses one plural field consistently:

```ts
enemyFacts: Array<{
  id: string;
  size: string;
  threat: string;
  typeIds: string[];
}>;
```

GM hand size counts unique values across all `typeIds` and multiplies that count
by the formula parameter `perEnemyType`.

## Verification

Before committing:

1. Run `git diff --check`.
2. Run `npm run content:verify`.
3. Run `npm run check`.
4. Run `npm test`.
5. Attempt the focused Test of Fate Playwright suite when the configured server
   can start. If the documented network-dependent build failure recurs, report
   it explicitly rather than treating the E2E suite as verified.
6. Inspect the final diff and working-tree file list to ensure no unrelated
   changes are included.

The final code commit message is:

```text
fix(tarot): address second adversarial review findings
```

## Stop condition

After the correction bundle is committed and its verification evidence is
reported, stop work and return control to the project owner.
