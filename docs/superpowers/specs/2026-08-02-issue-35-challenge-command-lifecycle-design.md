# Issue 35 Challenge Command Lifecycle Design

**Status:** Approved design for GitHub issue #35

**Goal:** Eliminate the Challenge end-turn E2E synchronization flake by giving the UI and Playwright helper one explicit command-lifecycle boundary, without weakening `failOnFlakyTests`, adding retries, or increasing the existing 15-second operation budgets.

## Problem Statement

Issue #35 records a `challenge-privacy.spec.ts` failure in which `clickCommand` timed out waiting for an `end-turn` `/challenge-commands` response. The same test passed on its first retry, no privacy assertion failed, and contemporaneous server commands completed in milliseconds.

The current helper starts `page.waitForResponse(...)` and `locator.click()` together in `Promise.all`. A response timeout is therefore only the first rejected branch; it does not prove that the click completed. The click may still be waiting for the button to become actionable while the Challenge action runner is processing the previous response and keeping all Challenge controls disabled.

The helper also returns when Playwright observes the response, before the browser has necessarily parsed that response, updated the campaign store, cleared `actionRunner.pending`, and rendered the new legal-command projection. A following loop iteration can inspect stale controls and begin another action while the previous UI lifecycle is unfinished.

Client-side command deduplication is not the leading cause. `ChallengePanel` owns one shared action runner, every Challenge button is disabled while it is pending, and `sendChallengeCommand` clears the store's in-flight entry before the runner clears its own pending state. A normal second click from this panel cannot reach store deduplication while the prior command is still pending.

## Design

### Application lifecycle signal

`ChallengePanel.svelte` will expose the shared action runner's state on the panel root as an explicit `aria-busy` value:

- `aria-busy="true"` from the moment `createChallengeAction.run` accepts an intent until its `send` promise resolves and the runner finishes processing the result.
- `aria-busy="false"` whenever the panel is ready to accept another Challenge action.

The value will be rendered explicitly as the strings `"true"` and `"false"`; it must not depend on how Svelte serializes or omits a boolean ARIA attribute. This has no visual effect. It describes the existing behavior to assistive technology and gives tests a stable, user-visible lifecycle boundary rather than a test-only event.

The existing per-control `disabled={actionRunner.pending}` behavior remains unchanged. The panel-level attribute reports the same state shared by all Challenge controls.

### Lifecycle-aware `clickCommand`

`tests/e2e/fixtures/challenge.ts` will keep `clickCommand(page, locator, timeoutMs = 15000)` as the single Challenge mutation helper, but its contract will cover the full interaction:

1. Register observation for the next Challenge command response before dispatching the click so a fast request cannot be missed.
2. Await `locator.click()` with its own `timeoutMs` actionability budget. If the button never becomes actionable, surface the click error rather than misreporting a missing response.
3. Await the matching `POST .../challenge-commands` response with a response deadline that preserves a full `timeoutMs` after the click's actionability budget. The implementation may register a `2 * timeoutMs` response wait before the click, because the click itself is capped at `timeoutMs`; this leaves at least one full response budget for a click that becomes actionable at the end of its allowance.
4. Read the response body once through Playwright and require both an HTTP-success status and `body.outcome.ok === true`. HTTP failures, unreadable bodies, and application-level rejections must produce distinct errors containing the locator, status when available, and server message when available.
5. Wait for the Challenge panel to report `aria-busy="false"` before returning. This wait uses `timeoutMs` and is the proof that the browser-side handler has consumed the response and settled the shared action runner.

The response-wait promise will convert rejection into a settled result immediately when it is created. This prevents an unhandled rejection if the click fails before the response wait is consumed. A click failure remains the primary error in that case.

All existing Challenge fixture call sites continue to use `clickCommand`; no per-call-site sleeps, retries, or duplicated stage waits are added.

## Data Flow

For a successful command, the observable sequence is:

1. Playwright registers the response observer.
2. Playwright waits for and dispatches the click.
3. `createChallengeAction.run` sets `pending` to true.
4. Svelte disables every Challenge control and renders `aria-busy="true"`.
5. `sendChallengeCommand` posts the command and receives the response.
6. The store parses the response and applies the non-stale projection.
7. The action runner receives the result, records success or error, and sets `pending` to false.
8. Svelte renders `aria-busy="false"` and the new legal controls.
9. `clickCommand` returns, allowing the test to inspect the next state or send the next command.

This boundary prevents the round-driving loops from observing the previous turn's controls between network completion and client completion.

## Error Handling

The helper will distinguish four failure classes:

- **Actionability failure:** the target never becomes clickable or is detached without a valid replacement. The original Playwright click error is surfaced.
- **Transport timeout/failure:** the click completes but no matching Challenge response arrives within the preserved response budget.
- **Command rejection:** the server responds, but HTTP status or `outcome.ok` rejects the command. The helper includes available response details instead of continuing into a later state mismatch.
- **Client lifecycle timeout:** the command succeeds, but `aria-busy` never returns to `"false"`. This identifies browser-side response processing or runner cleanup as the failing boundary.

The implementation will not retry an intent. Retry safety remains the responsibility of the existing sticky command-ID behavior after a genuine user retry.

## Regression Coverage

### Action runner unit coverage

Extend `tests/unit/components/challenge-action.test.ts` with deferred promises that prove:

- `runner.pending` becomes true synchronously after `run` begins and remains true while `send` is unresolved.
- `runner.pending` returns to false after both a successful result and a rejected result.

These tests protect the state that drives `aria-busy` without coupling the unit suite to Svelte DOM rendering.

### Deterministic helper regression

Add a focused Playwright spec for the helper contract. The test will render a minimal Challenge panel and button, intercept a successful URL containing `/challenge-commands`, set `aria-busy="true"` synchronously in the click handler, and deliberately delay the transition back to `"false"` until after the response is observable.

Immediately after `await clickCommand(...)`, a non-retrying attribute read must find `aria-busy="false"`. The current helper returns at response observation and fails this assertion while the panel is still busy. The lifecycle-aware helper waits and passes. This makes the race deterministic without slowing or weakening the full privacy journey.

The regression also includes an application-level rejected outcome and asserts that `clickCommand` reports it instead of treating an HTTP 200 response as success.

### Focused stress verification

After the focused tests pass, run both Challenge E2E specs repeatedly with two workers and Playwright retries disabled. This recreates the relevant CI contention while ensuring the fix, rather than a retry, provides stability.

Final validation includes `npm run check`, the unit suite, and the normal E2E suite with the existing `failOnFlakyTests` behavior intact.

## Files in Scope

- Modify `src/lib/components/campaign/table/challenge/ChallengePanel.svelte` to expose explicit `aria-busy` state.
- Modify `tests/e2e/fixtures/challenge.ts` to implement the complete command-lifecycle helper contract.
- Modify `tests/unit/components/challenge-action.test.ts` to protect pending-state semantics.
- Create `tests/e2e/challenge-command-helper.spec.ts` for deterministic helper synchronization and rejection coverage.
- Modify `CHANGELOG.md` by adding a `### Fixed` subsection under the existing empty `[Unreleased]` section and a user-facing note that Challenge controls now wait for command processing to settle before accepting the next action.

## Out of Scope

- Changes to Challenge engine legality, command schemas, server idempotency, or privacy projections.
- Changes to `campaign-session.svelte.ts` deduplication.
- New retries, arbitrary sleeps in production journeys, larger 15-second operation budgets, or disabling `failOnFlakyTests`.
- Refactoring the analogous guided-test, camp, finite-procedure, or correction helpers. They may adopt the same lifecycle pattern in separate work if evidence shows the same race.

## Acceptance Criteria

- The Challenge panel reports its shared action runner as explicit `aria-busy="true"` or `"false"`.
- `clickCommand` does not return until the click completed, a successful command outcome was received, and the Challenge panel returned to idle.
- A click/actionability failure cannot be reported merely as a response timeout.
- An HTTP 200 response with `outcome.ok !== true` fails at `clickCommand` with useful response context.
- The deterministic helper regression fails against the old helper and passes against the new helper.
- Repeated two-worker Challenge runs pass with retries disabled.
- Type checking, unit tests, and the normal E2E suite pass without changing the repository's flaky-test policy.
