# Contributing to Guild Book

Thanks for looking. Guild Book is a *His Majesty the Worm* adventurer creator and
rules reference, built as a SvelteKit monolith. Contributions are welcome —
this file covers how to get running, what you can and cannot run locally, and
the conventions the codebase already follows.

If anything here turns out to be wrong or incomplete, that is itself worth an
issue.

## Where to start

Check the [open issues](https://github.com/arrowedisgaming/guild-book/issues).
Issues labelled `good first issue` are self-contained and touch files nothing
else is actively changing.

**Before starting anything substantial, comment on the issue.** Some areas of
this codebase are under active work that is not visible from the commit history,
and a heads-up saves you from a painful rebase. See
[Areas currently reserved](#areas-currently-reserved) below.

## Setup

You need **Node 22** (what CI uses) and npm.

```bash
git clone https://github.com/arrowedisgaming/guild-book.git
cd guild-book
npm ci
cp .env.example .env
npm run db:push          # creates local.db with the current schema
npm run dev              # http://localhost:5173
```

`.env.example` is thoroughly commented — read it rather than skimming it. For
local development you do **not** need real OAuth credentials.

### Signing in locally

Two shortcuts, both development-only and both off by default:

- `AUTH_DEV_LOGIN=true` — adds a credentials provider to `/login`, so you can
  sign in as any email address.
- `AUTH_DEV_AUTOLOGIN=true` — skips `/login` entirely and signs you in as
  `dev@local` on first request. Also requires copying
  `src/lib/server/dev-auto-login.example.ts` to `src/lib/server/dev-auto-login.ts`
  (the real file is gitignored, so it cannot exist in a deployed build).

Neither has any effect unless `NODE_ENV=development`.

## Running the checks

These are what CI runs, and all of them work from a clean clone with no
credentials:

```bash
npm run check              # svelte-check / TypeScript
npm run test               # Vitest unit + integration
npm run test:e2e           # Playwright (needs: npx playwright install chromium)
npm run content:verify:ci  # content pack integrity
ADAPTER=cloudflare npm run build
```

A pull request needs `npm run check`, `npm run test` and `npm run test:e2e`
green. CI will run them for you, but running them locally first is faster than
waiting.

### One command you cannot run — and that is expected

```bash
npm run content:verify     # ← will fail for you. This is normal.
```

`content:verify` regenerates the content pack from the *His Majesty the Worm*
rulebook Markdown, which is copyrighted and therefore gitignored (`assets-src/`,
`rulebooks/`). It only ever runs on the maintainer's machine.

Use **`content:verify:ci`** instead. It verifies the committed content pack
against its committed manifest without needing the source material, which is
exactly what CI does. If you see `content:verify` fail with missing files, you
have not broken anything — you just ran the wrong one.

The same pattern applies elsewhere in the repo: anything that derives committed
output from licence-restricted source has a `:ci` variant that checks the output
instead. Prefer the `:ci` variant unless you know you have the source.

## How the codebase is organised

- **`static/content-packs/hmtw/`** — all game data, as JSON. Attributes, kindreds,
  callings, skills, talents, equipment, tarot configuration, rules. **Game rules
  are never hardcoded in components or routes.** If you find yourself writing a
  rule into a `.svelte` or `.ts` file, that is a sign it belongs in the pack.
- **`src/lib/engine/`** — pure, stateless functions. No UI imports, no DB
  imports, no `$app/` or `$lib/server/` imports. This is the primary unit-test
  target and the tarot resolution logic lives here.
- **`src/lib/server/`** — database, auth, and session/campaign internals.
- **`src/routes/`** — SvelteKit routes.
- **`docs/`** — architecture proposals, implementation plans, and operations
  runbooks. Several features have a full written plan under
  `docs/superpowers/plans/`; if an issue points you at one, that plan is the spec.

### Svelte 5

This project uses runes mode throughout. Match it:

- `let { foo, bar } = $props()` for props
- `$state()`, `$derived()`, `$derived.by()` for reactivity
- `{@render children()}` with the `Snippet` type for slots
- shadcn-svelte components are namespace imports:
  `import * as Card from '$lib/components/ui/card'`
- bits-ui uses the `child` prop, not `children`

### Style

There is no Prettier or ESLint config here on purpose. **Match the surrounding
code**: tabs for indentation, and the comment density and naming of the file you
are editing. Where the existing code explains *why* something is done a
particular way, that convention is worth continuing — several comments in this
repo exist because a subtle bug got fixed there once.

## Commits and pull requests

Commit messages follow Conventional Commits, scoped by area:

```
feat(campaigns): enforce shared production rate limits
fix(deploy): enable nodejs_compat so the Pages Function can publish
perf(campaigns): cut D1 round trips on the poll and command paths
docs(operations): record the post-reduction capacity gate
test(campaigns): validate remote D1 session behavior
```

Scopes in use include `campaigns`, `deploy`, `staging`, `operations`, `plans`,
`tarot-art`, `content`. Use an existing one where it fits.

Other expectations:

- **Stage files explicitly.** `git add <paths>`, not `git add .` or `git add src`.
  The gitignore protects licence-restricted material, but an explicit `add` is
  the habit that keeps it protected.
- **Update `CHANGELOG.md`** for anything user-visible, under `## [Unreleased]`,
  following [Keep a Changelog](https://keepachangelog.com/).
- **Tests come with the change.** This repo leans hard on tests — the engine
  layer targets 90%+ coverage — and several of the most valuable tests exist
  because they encode a rule that would otherwise be re-broken.
- Keep pull requests focused. One concern per PR reviews far faster.

### Protected main and releases

`main` is pull-request-only. GitHub rejects direct pushes, force pushes, and
branch deletion. Every pull request must be current with `main`, resolve all
review conversations, and pass the required `check` and `e2e` jobs before it
can merge. No approving review is required while the project has one
maintainer; the pull request and required checks are still mandatory.

Merging to `main` does not deploy production. Maintainers cut production only
from an annotated `vX.Y.Z` tag on an exact `main` commit after version,
changelog, local release verification, and any backward-compatible D1
migrations are ready. The tag runs the Release workflow; deployment waits for
approval in the protected `production` environment. Existing `v*` tags are
immutable. See `DEPLOY.md` for the complete release and rollback runbook.

## Licensing — please read before contributing content

The application source is **GPL-3.0-or-later** (see `LICENSE`). By opening a
pull request you agree your contribution ships under that licence.

The game content is a separate and stricter matter. Guild Book is published
under the ["Adherent of the Worm" open licence](https://www.hismajestytheworm.games/open-license).
*His Majesty the Worm* is copyright Joshua McCrowell; Guild Book is an
independent production by Arrowed and is **not** affiliated with Joshua
McCrowell or Exalted Funeral.

Concretely, in a pull request:

- **Never commit rulebook source material.** No PDFs, no rulebook Markdown, no
  transcriptions. `assets-src/` and `rulebooks/` are gitignored; keep it that way.
- **Never add HMTW artwork, logos, or trade dress.** The "Adherent of the Worm"
  logo is the single permitted mark.
- **No verbatim copyrighted rule text** beyond what the licence allows. The
  content pack paraphrases and encodes mechanics; it does not reproduce prose.
- If a change affects the licensing posture in any way, say so explicitly in the
  PR. Licensing text in `README.md`, `/licensing`, and the content pack README is
  maintained by the project owner and should not be edited by contributors —
  flag it instead and it will be handled.

## Areas currently reserved

These are under active work or need maintainer credentials. Please ask on an
issue before starting:

- **Campaign session internals** — `src/lib/server/session/repository.ts`,
  `command-service.ts`, `table-projections.ts`, `src/lib/server/auth.ts`,
  `src/hooks.server.ts`, and `tests/load/`. There is ongoing latency work in
  these files that has not landed yet.
- **Anything touching authorization caching** in the campaign path.
- **Deployment, production, and staging configuration** — `wrangler.toml`
  environments, Cloudflare bindings, and anything under `docs/operations/` that
  records a measured production run. These need account access and, in several
  cases, a decision rather than a patch.

Everything else is fair game.

## Feature flags

Campaigns (the shared tarot table) are gated off by default and unfinished.
`CAMPAIGNS_ENABLED=false` is the shipped state. You can turn it on locally to
work on it — set `CAMPAIGNS_ENABLED=true` and `CAMPAIGN_INVITE_SECRET` in `.env` —
but be aware the feature is mid-development and its server internals are on the
reserved list above.

## Questions

Open an issue. A question that turns out to be a documentation gap is a
contribution too.
