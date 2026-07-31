# Test and Release Hardening Design

**Date:** 2026-07-31
**Status:** Approved for implementation

## Goal

Turn the existing test suite into an enforceable release gate, preserve the
cross-player privacy canaries as hard failures, make intermittent browser
failures diagnosable, and add coverage around the two largest release-critical
client workflows: campaign synchronization and adventurer creation.

## Scope

This design implements every P0 and P1 item from the 2026-07-31 test-suite
review:

1. Harden and instrument the cross-player privacy boundary reported in GitHub
   issue #22 without weakening or retry-accepting its assertion.
2. Retain actionable Playwright evidence from CI failures.
3. Separate deterministic functional E2E verification from controlled
   concurrency/stress runs.
4. Gate production Cloudflare deployment on the exact release tag passing the
   full GitHub Actions verification workflow.
5. Add deterministic campaign-session store coverage and fix defects those
   tests demonstrate.
6. Add release-level wizard coverage for completion, persistence, navigation,
   reset, and invalid persisted state.

The P2 recommendations—component-test infrastructure, production-browser D1
smoke coverage, mutation testing, and broad per-domain coverage thresholds—are
deliberately outside this change.

## Privacy Boundary

The existing DOM poison-card test remains a required privacy canary. CI may run
one diagnostic retry to capture a trace, but a pass on retry must not convert
the failing run into success.

Every table bootstrap, changed `/sync` response, and command or lifecycle
response capable of replacing a projection will carry the authenticated
recipient user ID. The browser store will be constructed with the user ID from
server-rendered page data and will reject the complete response if its recipient
differs. It also rejects an initial snapshot whose recipient differs from the
store binding. Rejection preserves the last known-good snapshot and surfaces
only the existing generic sync or command error.
This is defense in depth for request/authentication cross-contamination: it does
not replace server-side actor-scoped projection or secret filtering.

The sync response will also carry a per-request correlation ID in an HTTP
header. Playwright's privacy fixture will attach request IDs, response status,
cursor, session version, and recipient to the failing test. It will not attach
card faces, private payloads, cookies, or authorization headers.

A server integration test will execute two concurrent sync requests with
independent request-scoped identities and poisoned secrets/projections. It must
prove that each response identifies the correct recipient and contains only
that recipient's private material. Store tests will prove that mismatched poll
and command responses are discarded even when they carry newer versions.

The intermittent CI evidence does not currently identify whether the original
bad state arose in auth, server projection, or browser application. The change
therefore does not claim an unproven singular root cause; it adds a fail-closed
client boundary and the evidence needed to locate any recurrence.

## Browser Test Profiles and Evidence

The default Playwright profile is the deterministic release profile:

- Chromium only.
- Two workers in CI, with tests within a file remaining serial.
- One diagnostic retry in CI with `failOnFlakyTests` enabled, so a pass on retry
  still fails the workflow.
- Trace retained on first retry, screenshot on failure, and video retained on
  failure.
- List output plus HTML and JUnit reports.

The CI workflow uploads the Playwright report, JUnit XML, `test-results`, and
captured web-server output on every failure or cancellation. Artifacts contain
test fixtures only, never production traffic.

A separate stress configuration runs the campaign synchronization and privacy
specifications with an explicit higher worker count and repetition. It is a
manual/scheduled diagnostic job, not a substitute for the deterministic release
profile. Product latency assertions such as the two-second cross-client budget
remain explicit; generic functional waits use the ordinary configuration
timeout.

## Release Gate and Deployment

`.github/workflows/ci.yml` becomes a reusable workflow while retaining its push
and pull-request triggers. It runs content verification, Svelte/TypeScript
checks, Vitest, the Cloudflare production build and Wrangler dry-runs, followed
by the deterministic Playwright profile.

`.github/workflows/release.yml` triggers only for tags matching `v*`. It:

1. Verifies that the tag exactly equals `v` plus `package.json`'s version and
   that the same version has a changelog heading.
2. Verifies that the tagged commit is reachable from `origin/main`.
3. Calls the reusable CI workflow against the tagged commit.
4. Checks out that exact tag in a deployment job which depends on verification.
5. Enters the protected GitHub `production` environment, where a human approval
   rule may pause the job.
6. Rebuilds the Cloudflare bundle and runs `wrangler deploy` using only
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment secrets.

Remote D1 migrations remain an explicit pre-deployment operator action because
schema ordering and preflight requirements differ by migration. The protected
environment approval is the checkpoint for confirming required migrations were
applied. Deployment documentation will contain the exact first-time setup and
release procedure. Direct local `wrangler deploy` remains possible for emergency
rollback, but the documented normal release path is exclusively the gated tag
workflow.

A local `npm run release:verify` command validates the current
package/changelog metadata, compares content changes with `origin/main`, and
mirrors all remaining credential-free release checks. It does not deploy or
touch remote D1.

## Campaign Session Store Coverage

Tests use fake timers and controllable fetch promises to verify:

- one listener per browser event and complete listener cleanup;
- visibility pause/resume, focus refresh, reconnect, and offline state;
- cancellation of an in-flight poll on stop;
- generic error sanitization for non-2xx and network failures;
- stale version protection for poll and command responses;
- recipient mismatch rejection;
- in-flight command deduplication and lifecycle transitions;
- the specialized Challenge, guided-test, Camp, correction, and finite command
  response paths.

Tests assert observable store state and request envelopes, not internal helper
calls. Any production changes follow a red-green cycle. Listener registration
and cleanup are covered as browser-lifecycle contracts even when the existing
implementation already satisfies them.

## Wizard Coverage

The release browser suite gains one full eight-step adventurer completion flow
using role- and label-based selectors. Store/unit coverage verifies persistence,
reload/resume, reset, schema-version migration behavior, invalid JSON recovery,
and guarded forward/backward navigation. Tests use the placeholder content pack
and assert saved character data, not just page headings or button clicks.

The tests reuse existing wizard APIs and content data. Production wizard
behavior changes only where a failing regression test identifies a real defect.

## Failure and Security Behavior

- Recipient mismatch: preserve the last safe snapshot, discard all events and
  projections from that response, and surface the fixed sync error.
- Failed deploy verification: deployment job never becomes eligible.
- Missing Cloudflare secrets: the protected deployment job fails before
  Wrangler can publish.
- Browser failure: CI remains red even if a diagnostic retry passes.
- Logs and artifacts: may contain synthetic fixture cards in screenshots,
  videos, traces, and network bodies, but never OAuth secrets, Cloudflare
  credentials, production cookies, or production data. Browser tests must not
  target production.

## Acceptance Criteria

- The original privacy assertions are unchanged or strengthened.
- Concurrent server tests prove request-scoped recipient isolation.
- Store tests prove mismatched-recipient sync, command, lifecycle, and initial
  responses cannot replace safe state.
- `npm run test`, `npm run check`, and the deterministic `npm run test:e2e`
  succeed.
- A deliberately flaky Playwright test would make CI fail even after retry.
- Failed browser jobs upload retained diagnostic artifacts.
- A `vX.Y.Z` tag cannot deploy unless metadata validation and the complete
  reusable CI workflow pass for that tagged commit.
- The production deployment job uses a protected GitHub environment and exact
  tagged source.
- Campaign store and wizard tests cover the behaviors listed above without
  relying on snapshots or implementation-only mocks.
