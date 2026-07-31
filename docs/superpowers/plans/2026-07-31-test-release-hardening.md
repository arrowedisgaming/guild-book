# Test and Release Hardening Implementation Plan

**Goal:** Make privacy-sensitive browser failures fail closed and diagnosable,
make the browser suite deterministic, gate tagged production deployments on the
exact verified commit, and add release-critical store and wizard coverage.

**Architecture:** Bind each table bootstrap and sync payload to its authenticated
recipient, reject mismatched payloads in the browser store, and preserve safe
correlation metadata for failed tests. Reuse one CI workflow from pull requests,
main pushes, and tagged releases; a protected production job deploys only after
the tagged commit passes. Add behavior-first tests around the campaign store and
wizard without introducing a second state implementation.

**Tech stack:** SvelteKit 2, Svelte 5, TypeScript, Vitest, Playwright, GitHub
Actions, Cloudflare Workers, Wrangler.

## Global constraints

- Do not weaken, skip, or retry-accept a privacy assertion.
- Do not log or attach card faces, private payloads, cookies, authorization
  headers, OAuth credentials, or Cloudflare credentials.
- Keep engine functions pure and keep game rules in content-pack JSON.
- Use test-first red-green cycles for production behavior changes.
- Do not add product, commit, branch, workflow, or documentation attribution to
  tools or automated authorship.
- Remote D1 migrations remain a deliberate operator action and are never run by
  the release workflow.

---

### Task 1: Bind sync payloads to their authenticated recipient

**Files:**

- Modify: `tests/unit/stores/campaign-session.test.ts`
- Modify: `tests/integration/session-api.test.ts`
- Modify: `tests/integration/session-privacy.test.ts`
- Modify: `src/lib/stores/campaign-session.svelte.ts`
- Modify: `src/routes/api/campaigns/[id]/sync/+server.ts`
- Modify: `src/routes/campaigns/[id]/table/+page.server.ts`
- Modify: `src/routes/campaigns/[id]/table/+page.svelte`
- Modify: `src/routes/campaigns/[id]/+page.server.ts`
- Modify: `src/routes/campaigns/[id]/+page.svelte`

**Interface:** `SessionSyncSnapshot` gains `recipientUserId: string`.
`CampaignSessionStoreOptions` gains required `recipientUserId: string` at every
browser call site. A successful `/sync` JSON body is
`{ recipientUserId, cursor, events, session }`; every response carries
`X-Request-Id`.

- [ ] Add a store test whose response has a different recipient, newer cursor,
  newer session version, and poisoned event. Assert that `poll()` rejects with
  the generic sync error and that no snapshot field changes.
- [ ] Run the focused store test and confirm it fails because recipient binding
  does not exist.
- [ ] Add integration expectations for recipient identity and a non-empty
  request ID on changed and unchanged sync responses.
- [ ] Run the focused integration tests and confirm the new expectations fail.
- [ ] Add recipient identity to SSR snapshots and `/sync`; merge the request ID
  with both JSON and 204 headers.
- [ ] Pass the server-rendered user ID into both table and campaign-dashboard
  stores.
- [ ] Reject a mismatched recipient before applying cursor, events, or session.
- [ ] Run the focused store and integration tests and confirm they pass.

### Task 2: Prove concurrent request-scoped privacy and retain safe evidence

**Files:**

- Modify: `tests/integration/session-privacy.test.ts`
- Modify: `tests/e2e/shared-table-privacy.spec.ts`
- Create: `tests/e2e/fixtures/sync-diagnostics.ts`

**Interface:** `captureSyncDiagnostics(page, testInfo, actorLabel)` records only
actor label, URL path, status, request ID, recipient, cursor, and session
version; `attachSyncDiagnostics(testInfo, records)` emits JSON test attachments.

- [ ] Add a concurrent integration test that starts player A and player B sync
  handlers together with independently constructed request events and
  request-scoped identities. Assert each recipient and poison boundary.
- [ ] Run it repeatedly and confirm it fails if the test still depends on the
  shared mutable auth mock.
- [ ] Refactor only the test harness needed to inject identity per request;
  preserve production authorization code.
- [ ] Run the concurrent test repeatedly and confirm stable isolation.
- [ ] Add the diagnostic fixture and use it in both privacy specifications.
- [ ] Attach diagnostics in `finally` so evidence survives an assertion failure,
  and keep the existing card-face assertions intact.
- [ ] Run both privacy specifications locally.

### Task 3: Cover and repair campaign-session lifecycle behavior

**Files:**

- Modify: `tests/unit/stores/campaign-session.test.ts`
- Modify: `src/lib/stores/campaign-session.svelte.ts`

**Interface:** Existing public store API remains unchanged apart from the
required recipient option/snapshot field from Task 1.

- [ ] Add a DOM-event harness and a failing test asserting `start()` registers
  exactly one visibility, focus, online, and offline listener and `stop()`
  removes each one.
- [ ] Confirm the test fails on the duplicate focus registration.
- [ ] Remove the duplicate registration and confirm the test passes.
- [ ] Add fake-timer tests for visible scheduling, hidden cancellation,
  visibility refresh, focus refresh, online refresh, and offline state.
- [ ] Add an abort test using a pending fetch and verify `stop()` aborts it.
- [ ] Add non-2xx and network failure tests proving only the fixed generic error
  is surfaced and recovery clears it.
- [ ] Add request-envelope and in-flight dedup tests for ordinary and lifecycle
  commands.
- [ ] Add accepted-response tests for Challenge, guided-test, Camp, correction,
  and finite command projections.
- [ ] Run the complete campaign store test file after each behavior group.

### Task 4: Cover wizard persistence and the complete creation flow

**Files:**

- Create: `tests/unit/stores/wizard.test.ts`
- Modify: `tests/e2e/wizard-smoke.test.ts`
- Modify only if a failing test proves a defect: `src/lib/stores/wizard.ts`

**Interface:** The wizard's current store API and `WIZARD_STEPS` remain the
single source of truth.

- [ ] Add unit tests for pristine detection, migration, completed-step
  deduplication, guarded accessibility, draft summary, start/reset nonce, and
  character updates.
- [ ] Add browser-backed persistence tests for valid stored state, invalid JSON
  removal, invalid shape removal, reload/resume, and reset removal.
- [ ] If the module singleton prevents isolated storage tests, extract a
  `createWizardStore(storage?)` factory without changing the exported singleton.
  First add the failing isolation test, then make the minimal extraction.
- [ ] Build one complete eight-step browser flow using labels and roles from the
  placeholder content pack.
- [ ] Assert the review data and saved character record, not merely navigation.
- [ ] Reload during the flow and prove the draft resumes at the correct step.
- [ ] Run the wizard unit and browser specifications.

### Task 5: Make Playwright deterministic and preserve CI artifacts

**Files:**

- Modify: `playwright.config.ts`
- Create: `playwright.stress.config.ts`
- Create: `scripts/e2e/run-ci.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interface:**

- `npm run test:e2e` is the deterministic release profile.
- `npm run test:e2e:stress` is the explicit concurrency/repetition profile.
- `npm run test:e2e:ci` writes combined process/server output to
  `test-results/playwright-output.log` and preserves Playwright's exit code.

- [ ] Add a configuration test or import-time assertion proving CI uses two
  workers, one diagnostic retry, `failOnFlakyTests`, and failure artifacts.
- [ ] Confirm the assertion fails against the current configuration.
- [ ] Configure CI workers/retries/flaky handling, list+HTML+JUnit reporters,
  trace-on-retry, failure screenshots, and failure video.
- [ ] Add the stress config targeting campaign sync/privacy specs with explicit
  workers and repetition; do not run it in the required PR path.
- [ ] Add a small Node runner that tees Playwright stdout/stderr to a file and
  returns the child exit status without a shell pipeline.
- [ ] Update CI to use current checkout/setup actions, time out stalled jobs,
  run `test:e2e:ci`, and upload HTML/JUnit/results/log artifacts on
  `failure() || cancelled()`.
- [ ] Add a scheduled/manual stress workflow or job which cannot authorize a
  production deployment.
- [ ] List and run both Playwright profiles to validate selection and workers.

### Task 6: Add exact-tag release validation and protected deployment

**Files:**

- Create: `scripts/release/validate-tag.mjs`
- Create: `tests/unit/release-tag.test.ts`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `DEPLOY.md`
- Modify: `CHANGELOG.md`

**Interface:**

- `validateReleaseTag(tag, packageVersion, changelog)` returns an array of
  human-readable validation errors; the CLI exits nonzero when errors exist.
- `npm run release:validate -- v0.8.0` validates metadata only.
- `npm run release:verify` performs every credential-free release check.
- Tags matching `v*` invoke reusable CI; deployment uses the protected
  `production` environment and Cloudflare environment secrets.

- [ ] Add failing tests for matching tag/version/changelog, mismatched tag,
  missing changelog heading, malformed semver, and prerelease versions.
- [ ] Implement the pure validator and CLI, then run its unit tests.
- [ ] Add `workflow_call` to CI without removing push/PR triggers.
- [ ] Add a tag-triggered release workflow with metadata, reusable verification,
  and deployment jobs. Make deployment depend on both prior jobs and check out
  the same tag commit.
- [ ] Set `environment: production` and pass only
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` to `wrangler deploy`.
- [ ] Add `release:validate` and credential-free `release:verify` scripts.
- [ ] Document repository environment creation, required reviewer, least-scope
  Cloudflare token, account ID, migration checkpoint, tag creation, monitoring,
  and rollback.
- [ ] Add a changelog entry describing the privacy, CI, test, and release gate
  behavior.
- [ ] Parse both workflow files as YAML and run Wrangler dry-runs locally.

### Task 7: Full verification and review

**Files:** all modified files.

- [ ] Run `npm run content:verify:ci` with an appropriate base reference.
- [ ] Run `npm run check`.
- [ ] Run `npm run test`.
- [ ] Run `npm run test:e2e`.
- [ ] Run the focused stress profile at least once.
- [ ] Run `ADAPTER=cloudflare AUTH_SECRET=release-build-validation-only npm run build`.
- [ ] Run production and staging Wrangler dry-runs.
- [ ] Run `git diff --check` and inspect the complete diff for private-data,
  attribution, and accidental generated-file changes.
- [ ] Obtain an independent code review and address every material finding.
- [ ] Re-run affected tests after review changes and record any remaining
  external setup: GitHub production environment, reviewer, and Cloudflare
  secrets.
