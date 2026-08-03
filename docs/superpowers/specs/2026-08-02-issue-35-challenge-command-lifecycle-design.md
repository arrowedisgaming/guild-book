# Issue 35 Challenge Command Lifecycle Design

**Status:** Revised after review; pending final approval for GitHub issue #35

**Goal:** Remove issue #35's same-page Challenge command sequencing race by giving the controls and Playwright helper one explicit lifecycle boundary, using staged diagnostic timeouts without weakening `failOnFlakyTests` or adding retries.

## Problem Statement

Issue #35 records a `challenge-privacy.spec.ts` failure in which `clickCommand` timed out waiting for an `end-turn` `/challenge-commands` response. The same test passed on its first retry, no privacy assertion failed, and contemporaneous server commands completed in milliseconds.

The current helper starts `page.waitForResponse(...)` and `locator.click()` together in `Promise.all`. A response timeout is therefore only the first rejected branch; it does not prove that the click completed. The click may still be waiting for the button to become actionable while the Challenge action runner is processing the previous response and keeping all Challenge controls disabled.

The helper also returns when Playwright observes the response, before the browser has necessarily parsed that response, updated the campaign store, cleared `actionRunner.pending`, and rendered the new legal-command projection. A following loop iteration can inspect stale controls and begin another action while the previous UI lifecycle is unfinished.

Client-side command deduplication is not the leading cause. `ChallengePanel` owns one shared action runner, every Challenge button is disabled while it is pending, and `sendChallengeCommand` clears the store's in-flight entry before the runner clears its own pending state. A normal second click from this panel cannot reach store deduplication while the prior command is still pending.

## Design

### Application lifecycle signal

`ChallengePanel.svelte` will add a `data-testid="challenge-controls"` wrapper around `TurnControls`, `GmChallengeControls`, and `ModifierControls`. The existing header, stage, Initiative order, turn budget, and especially the `aria-live="polite"` Challenge announcement remain outside this wrapper.

The wrapper will mirror the shared runner with `aria-busy={actionRunner.pending ? 'true' : 'false'}`. This is deliberately only a one-line projection of existing state; it does not introduce another lifecycle or state machine. The explicit strings avoid depending on whether Svelte serializes or omits a boolean ARIA attribute.

Keeping the live region outside the busy subtree is required. `aria-busy="true"` permits assistive technology to defer changes within that subtree, while another client's event can update the announcement during the local command. The wrapper lets the controls report their existing in-progress state without delaying or swallowing those announcements.

The wrapper will use the panel's existing column layout and gap so adding the element does not change the visual grouping. The existing per-control `disabled={actionRunner.pending}` behavior remains unchanged.

### Lifecycle-aware `clickCommand`

`tests/e2e/fixtures/challenge.ts` will keep `clickCommand(page, locator, timeoutMs = 15000)` as the single Challenge mutation helper, but its contract will cover the full interaction:

1. Register observation for the next Challenge command response before dispatching the click so a fast request cannot be missed.
2. Await `locator.click()` with its own `timeoutMs` actionability budget. If the button never becomes actionable, surface the click error rather than misreporting a missing response.
3. Await the matching `POST .../challenge-commands` response with a response observer capped at `2 * timeoutMs` from registration. Because that observer runs concurrently with the click, a click that uses its full `timeoutMs` still leaves one full `timeoutMs` for the response.
4. Read the response body once through Playwright and require both an HTTP-success status and `body.outcome.ok === true`. The Challenge command endpoint has one response path after access control: `json({ recipientUserId, outcome, projection, challengeProjection, challengeLegalCommands }, { status })`. It has no successful or rejected 204 branch, so a missing or unreadable body is a contract failure rather than a valid privacy response. HTTP failures, unreadable bodies, and application-level rejections must produce distinct errors containing the locator, status when available, and server message when available.
5. Wait for `[data-testid="challenge-controls"]` to report `aria-busy="false"` before returning. This wait has its own `timeoutMs` and is the proof that the browser-side handler has consumed the response and settled the shared action runner.

The response-wait promise will convert rejection into a settled result immediately when it is created. This prevents an unhandled rejection if the click fails before the response wait is consumed. A click failure remains the primary error in that case.

The helper will document why the final busy-state check cannot pass by reading the pre-click `"false"`: `run` sets `pending = true` synchronously in the click handler, and Svelte flushes that state in a microtask before the later network task can deliver a response. By the time Playwright observes the response, the wrapper has already rendered `aria-busy="true"`; only completion of the handler can return it to `"false"`.

All existing Challenge fixture call sites continue to use `clickCommand`; no per-call-site sleeps, retries, or duplicated stage waits are added.

## Data Flow

For a successful command, the observable sequence is:

1. Playwright registers the response observer.
2. Playwright waits for and dispatches the click.
3. `createChallengeAction.run` sets `pending` to true.
4. Svelte disables every Challenge control and renders `aria-busy="true"` on the controls wrapper; the live announcement remains outside that subtree.
5. `sendChallengeCommand` posts the command and receives the response.
6. The store parses the response and applies the non-stale projection.
7. The action runner receives the result, records success or error, and sets `pending` to false.
8. Svelte renders `aria-busy="false"` on the controls wrapper and the new legal controls.
9. `clickCommand` returns, allowing the test to inspect the next state or send the next command.

This boundary prevents the round-driving loops from observing the previous turn's controls between network completion and client completion.

### Cross-client boundary

The lifecycle signal covers only the page that sent the command. It does not make another browser context receive the new state sooner. Consecutive commands on different pages remain synchronized by the existing `findActingPage`, `waitForStage`, `anyPageShowsTurnControls`, and the privacy journey's `anyoneHasTurnControls` polling, all of which allow the next client's approximately 1.15-second sync cadence to publish its legal controls.

That residual cross-client polling is intentional and outside this fix. A future failure in which the sender is idle but the next client never becomes ready is a different synchronization axis, not evidence that the same-page lifecycle boundary failed.

### Timeout envelope

The helper uses staged 15-second phase budgets rather than the old single 15-second `Promise.all` budget. Its worst-case wall time is 45 seconds: at most 30 seconds from response-observer registration through response arrival, followed by at most 15 seconds for client settlement. The click's 15-second budget overlaps the first half of that 30-second response window, so the phases do not total 60 seconds.

Both full Challenge journeys set a 180-second Playwright test timeout. Their recorded healthy durations are approximately 41 seconds for the privacy journey and 87 seconds for the full journey. One helper invocation reaching the new 45-second ceiling adds at most 30 seconds over the old ceiling, leaving either journey below 180 seconds. The global timeout is intentionally not increased to accommodate dozens of commands each exhausting their phase budgets; repeated near-timeout commands represent systemic failure and should terminate the test.

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

Add a focused Playwright spec for the helper contract. This is explicitly a simulation of the DOM contract, not a render of the real Svelte component:

1. Use `page.setContent` to create hand-written HTML containing `[data-testid="challenge-controls"][aria-busy="false"]` and a command button.
2. Install a browser click handler that synchronously changes the wrapper to `aria-busy="true"`, fetches `/challenge-commands`, consumes its JSON body, marks the wrapper `data-response-consumed="true"`, waits on a promise whose resolver is retained on `window`, and then restores `aria-busy="false"`.
3. Use `page.route('**/challenge-commands')` to fulfill the POST with a successful JSON `outcome`.
4. Start `clickCommand` without awaiting it and track whether its promise settles. Wait for `data-response-consumed="true"`, then allow the Node promise queue one microtask turn and assert that the helper is still pending while the simulated client remains at the completion gate.
5. Call the retained resolver with `page.evaluate`, await the helper, and read `aria-busy` once without retrying to prove it returned only after idle.

The old helper resolves before the completion gate is released and fails step 4. The lifecycle-aware helper remains pending and passes. An explicit gate makes the race deterministic without using a timing sleep.

The spec does not navigate to the application, create accounts, or use the auth, campaign, database, or Challenge orchestration fixtures. It still runs under the repository's normal Playwright configuration, so the global configured web server starts even though this isolated test does not depend on it.

The regression also includes an application-level rejected outcome and asserts that `clickCommand` reports it instead of treating an HTTP 200 response as success.

### Focused stress verification

After the focused tests pass, run both Challenge E2E specs repeatedly with two workers and Playwright retries disabled. This recreates the relevant CI contention while ensuring the fix, rather than a retry, provides stability.

Final validation includes `npm run check`, the unit suite, and the normal E2E suite with the existing `failOnFlakyTests` behavior intact.

## Files in Scope

- Modify `src/lib/components/campaign/table/challenge/ChallengePanel.svelte` to wrap only the mutation controls in `data-testid="challenge-controls"` with explicit `aria-busy` state, leaving the live region outside.
- Modify `tests/e2e/fixtures/challenge.ts` to implement the complete command-lifecycle helper contract.
- Modify `tests/unit/components/challenge-action.test.ts` to protect pending-state semantics.
- Create `tests/e2e/challenge-command-helper.spec.ts` for deterministic helper synchronization and rejection coverage.
- Modify `CHANGELOG.md` by adding a `### Added` subsection under the existing empty `[Unreleased]` section and a user-facing note that Challenge controls report their in-progress state to assistive technology without delaying Challenge announcements. The test-helper synchronization change is internal and receives no separate changelog bullet.

## Out of Scope

- Changes to Challenge engine legality, command schemas, server idempotency, or privacy projections.
- Changes to `campaign-session.svelte.ts` deduplication.
- New retries, arbitrary sleeps in production journeys, increasing any individual click, post-click response, or client-settlement phase beyond 15 seconds, or disabling `failOnFlakyTests`. The pre-registered response observer's 30-second aggregate ceiling exists only because it overlaps the click phase and preserves a full 15-second post-click response window.
- Refactoring the analogous guided-test, camp, finite-procedure, or correction helpers. They may adopt the same lifecycle pattern in separate work if evidence shows the same race.
- Replacing the existing cross-client polling helpers or changing the approximately 1.15-second sync cadence.

## Acceptance Criteria

- The Challenge controls wrapper reports its shared action runner as explicit `aria-busy="true"` or `"false"`; the `aria-live` announcement is outside that wrapper.
- `clickCommand` does not return until the click completed, a successful command outcome was received, and the sending page's Challenge controls returned to idle.
- A click/actionability failure cannot be reported merely as a response timeout.
- An HTTP 200 response with `outcome.ok !== true` fails at `clickCommand` with useful response context.
- The deterministic helper regression fails against the old helper and passes against the new helper.
- The command-response body requirement is backed by the endpoint's unconditional JSON response shape and lack of a 204 branch.
- Repeated two-worker Challenge runs pass with retries disabled.
- Type checking, unit tests, and the normal E2E suite pass without changing the repository's flaky-test policy or the two Challenge journeys' 180-second timeout.
