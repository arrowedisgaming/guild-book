# GitHub Release Governance Design

**Date:** 2026-07-31 · **Status:** Approved for implementation

## Purpose

Make GitHub the enforced path for integrating changes and deploying Guild Book.
Every change to `main` must arrive through a pull request whose required CI jobs
pass. Production must deploy only from a validated version tag after an explicit
approval in the protected GitHub environment.

## Current State

- Local `main` contains the test and release hardening work but is six commits
  ahead of `origin/main`.
- `.github/workflows/release.yml` implements tag validation, reusable CI, a
  protected `production` environment, and the Cloudflare deployment, but it has
  not reached GitHub yet.
- GitHub has no branch ruleset, classic branch protection, `production`
  environment, or environment secrets.
- The existing `check` and `e2e` GitHub Actions jobs are the authoritative pull
  request checks.
- The retired Cloudflare Pages project still builds and publishes a Pages
  deployment on every `main` push. It no longer owns the production hostname,
  but it remains an unintended second deployment path.

## Repository Integration Policy

Create an active repository ruleset targeting the default branch with these
rules:

1. Require every change to be associated with a pull request.
2. Require zero approving reviews. The project currently has one maintainer, so
   the pull request is an enforced integration and audit gate rather than a
   mandatory second-person review.
3. Require the GitHub Actions checks named `check` and `e2e`.
4. Require the pull request branch to be current with `main` before merging.
5. Require review conversations to be resolved.
6. Block force pushes and deletion of `main`.
7. Define no routine bypass actor. Emergency recovery requires an explicit,
   temporary settings change and documentation of why it was necessary.

The ruleset does not require signed commits or linear history. Those are useful
independent policies but are not needed to enforce the agreed release process.

Rule 4 has a known cost: with the 30-minute `e2e` job required, every merge to
`main` invalidates other open pull requests and forces their checks to re-run.
That is acceptable for a one-maintainer project and is the price of the rule;
do not weaken the rule to avoid the re-runs.

### Tag Ruleset

Create a second active ruleset targeting tags matching `v*` that blocks tag
updates and deletions, with no bypass actors. The prohibition on moving or
recreating release tags must be enforced by GitHub, not just stated as policy:
without this ruleset, anyone with write access can delete and re-push a `v*`
tag and the release workflow will re-fire. Creating new `v*` tags remains
allowed; only mutation and deletion of existing ones are blocked.

### Continuous Integration Triggers

`ci.yml` keeps its `push: branches: [main]` trigger even though rule 4 makes
the post-merge run largely redundant with the pull request run on the identical
tree. The duplication is intentional: the push run is cheap insurance against
merge-time drift, and the trigger block also serves the `workflow_call` reuse
from the release workflow. Do not remove it as a cleanup.

## Production Deployment Policy

Create a GitHub environment named exactly `production` with:

- `arrowedisgaming` as the required reviewer;
- self-review allowed, because preventing it would deadlock a one-maintainer
  release;
- administrator bypass disabled;
- deployment restricted to selected tags matching `v*`;
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` stored as environment
  secrets.

The Cloudflare token must be dedicated to deployment and restricted to the
account containing `guild-book` and the `arrowed.games` zone, with a named
least-privilege permission set: account-level Workers Scripts: Edit and Account
Settings: Read, plus zone-level Workers Routes: Edit. The Release workflow does
not run migrations, so this token receives no D1, KV, R2, or Tail permission.
Record the granted permissions in `DEPLOY.md` when the token is created. Secret
values must
be entered through GitHub or a non-echoing CLI prompt; they must never be placed
in repository files, command arguments, chat messages, issue comments, or logs.

Disable automatic production-branch deployments and set preview branches to
`None` on the legacy Cloudflare Pages project. Do not enable Workers Builds or
any other push-to-deploy integration.

The legacy Pages project is a decaying asset, not a durable rollback path: with
builds disabled it freezes at its last deployment while releases keep applying
D1 migrations, so within a release or two rolling back to it would run old code
against a newer schema — potentially worse than an outage. Preserve it only
until the first post-governance release ships cleanly and passes its production
smoke test, then retire it per the operational runbook. Rollback after that
point uses the release-workflow path described under Failure and Recovery,
never the Pages artifact.

## Normal Change Flow

1. Create a focused branch from current `main`.
2. Make and validate the change locally.
3. Push the branch and open a pull request into `main`.
4. Wait for `check` and `e2e` to pass.
5. Resolve review conversations and merge through GitHub.
6. Delete the merged branch when it no longer contains untracked work.

Direct pushes to `main` are not part of the normal or release workflow.

## Release Flow

1. Prepare the version and dated changelog entry on a branch, fetch
   `origin/main`, run `npm run release:verify` on that branch (the content-pack
   comparison is only meaningful before `origin/main` contains the change), and
   merge through the normal pull request flow.
2. Check out the exact merged commit, fetch tags (`git fetch --tags origin`),
   and validate the proposed tag with
   `npm run release:validate -- vX.Y.Z --require-new`.
3. Confirm required production D1 migrations and preflights are complete.
   Because migrations apply before the new code deploys, and because D1
   migrations do not roll back, every migration must be backward compatible
   with the currently deployed release. This is a standing constraint on how
   migrations are written, not a release-day check.
4. Create and push an annotated `vX.Y.Z` tag pointing to that exact `main`
   commit.
5. Wait for release metadata validation and the reusable `check` and `e2e`
   jobs to pass.
6. Review the pending deployment — confirming the tag commit is the current
   `origin/main` head, since the workflow only enforces ancestry — and approve
   the `production` environment.
7. Monitor the deployment to completion and run the documented production
   smoke test.

Moving or recreating a failed release tag is forbidden. Fix the failure on a
new branch and commit, merge it through a pull request, and choose a new version
tag when necessary.

## Preserving the Process

Update these durable instructions:

- `CONTRIBUTING.md`: explain PR-only `main`, required checks, the separation
  between merging and releasing, and the maintainer release sequence.
- the gitignored local agent instruction files: add concise publishing
  constraints so local development tools discover them before changing Git or
  GitHub state without forcing either file into the repository.
- `DEPLOY.md`: record that both legacy Pages auto-deployment controls are off
  after the dashboard change is confirmed.
- the local `ship-it` skill: teach it to detect repository-specific protected
  branch and gated-release policies, prohibit direct pushes to protected
  default branches, and treat environment approval as a distinct user gate.

Project files and Git history must contain no automated-authorship attribution,
generated-by footer, or automated co-author trailer.

## Bootstrap Sequence

The current local hardening commits and the governance documentation —
including this design document itself — will form the first feature branch.
Before activating the rulesets, push that branch and open its pull request.
Then create the environment and both rulesets. Once `check` and `e2e` pass,
merge the bootstrap pull request through GitHub. Do not push local `main`
directly.

Merge the bootstrap pull request with a **merge commit**, not a squash. A
squash would collapse the six individual hardening commits into one and lose
their history. GitHub cannot fast-forward-merge a pull request, so after the
merge `origin/main` will contain a merge commit that local `main` does not.

Immediately after the merge, reset local `main` to `origin/main`
(`git fetch origin && git checkout main && git reset --hard origin/main`).
The stale local `main` — still six commits "ahead" by SHA — is otherwise a
loaded gun: it can no longer be pushed, by design, but leaving it divergent
invites confusion in every later release step that checks out `main`.

While the ruleset is newly active, perform one deliberate throwaway push
attempt to `main` (a trivial commit) and confirm GitHub rejects it. This is
harmless precisely because it is rejected, and it is the only real test of
enforcement — reading the ruleset back only verifies configuration.

Environment credentials may be added before or after the bootstrap merge, but
no release tag may be pushed until both secrets exist and the legacy Pages
automatic deployments are disabled.

## Verification

- Validate repository files with `git diff --check` and the applicable local
  test and release commands.
- Confirm the bootstrap pull request reports passing `check` and `e2e` jobs.
- Read back the active branch ruleset and verify its target, required checks,
  pull request requirement, force-push rule, deletion rule, and bypass list.
- Read back the tag ruleset and verify it targets `v*`, blocks updates and
  deletions, and has no bypass actors.
- Read back the `production` environment and verify its reviewer, tag policy,
  self-review behavior, administrator bypass setting, and environment secret
  names without exposing values.
- Confirm direct updates to `main` are rejected via the one deliberate
  throwaway push attempt in the bootstrap sequence. Configuration read-back
  alone does not verify enforcement.
- Confirm the legacy Pages project no longer builds production or preview
  branches automatically.
- Baseline-test the unchanged local `ship-it` skill with a release-pressure
  scenario, make the minimal guidance update, validate its structure, and
  forward-test the revised skill against the same scenario.

## Failure and Recovery

- If a release deploys successfully but the production smoke test fails, roll
  back by re-running the previous good tag's release workflow and approving
  its `production` deployment again; `npx wrangler rollback` is the faster
  interim option while that re-run is in flight, and the only option when the
  previous run is older than GitHub's 30-day re-run window (an immutable tag
  cannot be re-pushed to start a fresh run). Rollback restores code only —
  D1 migrations do not roll back, which is why every migration must stay
  backward compatible with the previously deployed release. Fix forward on a
  new branch and new version tag as usual.
- If required checks do not appear, leave the pull request open and correct the
  ruleset check names; do not weaken the gate to merge.
- If the environment cannot be approved, verify the required reviewer and that
  self-review remains allowed.
- If GitHub credentials or Cloudflare credentials are unavailable, stop before
  the affected mutation and preserve the remaining setup state.
- If GitHub Actions is unavailable during a genuine production incident, use
  the documented local Cloudflare recovery path only with explicit approval and
  record the incident before restoring the normal gate.
