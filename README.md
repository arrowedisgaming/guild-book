# Guild Book

A **His Majesty the Worm** adventurer creator and rules reference — a companion web app in
the spirit of the [Miskatonic University Registrar](https://github.com/arrowedisgaming/MiskatonicUniversityRegistrar),
built for the tarot-driven dungeon crawler by Joshua McCrowell.

> Awaken, querent. Assemble an adventurer, consult the rules, and let the cards decide.

## What it does

- **Adventurer creator** — a guided, content-pack-driven wizard for building a character.
- **Rules reference** — a browsable, searchable reference.
- **Virtual tarot deck** — HMTW's core resolution tool, usable during creation and standalone.
- Sign in with **Google** or **Discord**; save adventurers, export to PDF or Markdown, and
  share read-only links.

## Stack

SvelteKit 2 · Svelte 5 (runes) · TypeScript · Tailwind v4 · Drizzle ORM · Auth.js ·
Cloudflare Pages + D1 (production) with a local SQLite fallback for development.

## Development

```bash
npm install
cp .env.example .env      # fill in AUTH_* secrets, or set AUTH_DEV_LOGIN=true for local dev
npm run db:push           # create/refresh the local SQLite schema
npm run dev               # http://localhost:5173
```

For a zero-click local login, set `AUTH_DEV_LOGIN=true` in `.env` and sign in with the dev
credentials provider on `/login`.

Useful scripts: `npm run check` (types), `npm run test` (Vitest), `npm run test:e2e`
(Playwright).

## Content packs

All game data lives in `static/content-packs/hmtw/` as JSON. The committed pack is a
clearly-marked **placeholder**; real His Majesty the Worm rules data is dropped into these
files with no code changes. See that folder's README for the swap procedure.

## Licence

Application source: **GPL-3.0-or-later** (see [`LICENSE`](./LICENSE)).

His Majesty the Worm is copyright Joshua McCrowell. Guild Book is an independent production
by Arrowed and is **not** affiliated with Joshua McCrowell or Exalted Funeral. It is
published under the ["Adherent of the Worm" open licence](https://www.hismajestytheworm.games/open-license).
No His Majesty the Worm artwork, logos, or trade dress are reproduced.
