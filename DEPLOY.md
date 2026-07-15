# Deploying Guild Book (Cloudflare Pages + D1)

Production target: **Cloudflare Pages** (Git-connected, so every push to `main`
auto-deploys; PR branches get preview URLs) with **D1** as the database.

Build: `ADAPTER=cloudflare npm run build` → output `.svelte-kit/cloudflare`
(verified locally). The D1 binding is declared in `wrangler.toml`, which Pages
reads at build time.

---

## 1. One-time: create the D1 database

```bash
npx wrangler login                       # opens browser → authorize
npx wrangler d1 create guild-book-db     # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_D1_DATABASE_ID`), then commit and push — Pages reads this file,
so the binding must be real before the first deploy.

Apply the schema to the remote database:

```bash
npm run db:migrate:d1:remote             # wrangler d1 migrations apply guild-book-db --remote
```

## 2. One-time: create the Pages project (this enables auto-deploys)

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

1. Authorize the Cloudflare GitHub App for the `arrowedisgaming` org and select
   the **guild-book** repo (private is fine).
2. Production branch: **main**.
3. Build command: `ADAPTER=cloudflare npm run build`
4. Build output directory: `.svelte-kit/cloudflare`
5. Create & deploy.

That Git connection **is** the auto-deploy: every push to `main` builds and
ships production; every other branch/PR gets a preview URL.

### Environment variables (Pages project → Settings → Variables and Secrets, Production)

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | `openssl rand -base64 33` (mark as Secret) |
| `AUTH_URL` | `https://guildbook.arrowed.games` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | from Google Cloud Console (step 3) |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | from Discord Developer Portal (step 3) |
| `NODE_VERSION` | `22` |

(`ADAPTER` is only a build-time switch and is set in the build command.
Do **not** set `AUTH_DEV_LOGIN`/`AUTH_DEV_AUTOLOGIN` in production.)

### D1 binding

`wrangler.toml` declares `[[d1_databases]] binding = "DB"` — Pages picks it up
automatically once the `database_id` is real. Verify under
**Settings → Bindings** after the first deploy; if it's missing, add a D1
binding manually: name `DB` → database `guild-book-db`.

## 3. One-time: OAuth apps

Auth.js callback paths are `/auth/callback/<provider>`.

**Google** — [console.cloud.google.com](https://console.cloud.google.com) →
APIs & Services → Credentials → Create OAuth client ID (Web application):
- Authorized redirect URI: `https://guildbook.arrowed.games/auth/callback/google`
- (Optionally also `https://<project>.pages.dev/auth/callback/google` for
  testing before the domain is attached.)
- Configure the consent screen (external, app name "Guild Book", publish).

**Discord** — [discord.com/developers/applications](https://discord.com/developers/applications)
→ New Application → OAuth2:
- Redirect: `https://guildbook.arrowed.games/auth/callback/discord`
- Copy Client ID + Client Secret.

Put the four values into the Pages env vars above and redeploy
(**Deployments → Retry** or push any commit).

## 4. One-time: custom domain

Pages project → **Custom domains → Set up a custom domain** →
`guildbook.arrowed.games`. If `arrowed.games` is already a Cloudflare zone on
this account, the DNS record is created automatically; otherwise add the CNAME
it prints.

## 5. Smoke test

1. `https://guildbook.arrowed.games/` loads with the book typography.
2. Sign in with Google, then Discord.
3. Create an adventurer end-to-end and save; confirm it appears in
   **My Adventurers** (that's a D1 round-trip).
4. Open the sheet: toggle a condition (autosave), Take a Wound, download the
   PDF, mint a share link and open it in a private window.
5. `/licensing` shows the required notice.

## Ongoing

- **Deploy** = `git push` to `main`. Nothing else.
- **Schema changes**: `npm run db:generate` locally and commit the migration.
  Apply every required remote migration **before** pushing or merging code that
  depends on it; pushes to `main` deploy immediately and CI does not migrate D1.
- **Auth account-linking migrations**: before merging this release, run
  `npm run db:auth:preflight:d1:remote`, confirm both result sets are empty,
  then run `npm run db:migrate:d1:remote`. Do not deploy the adapter-backed auth
  code until every migration succeeds. Rotate `AUTH_SECRET` during the rollout
  to sign out legacy sessions.
- **Rollback**: Pages → Deployments → ⋯ → Rollback to this deployment.
- Logs: Pages project → the deployment → **Functions** tab (real-time tail:
  `npx wrangler pages deployment tail --project-name guild-book`).

## Pre-launch licence reminder

`static/fonts/LICENSES.md`: Goudy Old Style is a Monotype commercial face —
license it for web embedding or swap the `--font-sidebar` token to an OFL
substitute (e.g. Sorts Mill Goudy) before a genuinely public launch.
