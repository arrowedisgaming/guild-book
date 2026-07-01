// Placeholder database module.
//
// Phase 2 replaces this file wholesale with the real dual-target resolver
// (Cloudflare D1 via `platform.env.DB`, falling back to better-sqlite3 for
// local Node) plus the Drizzle schema wiring — copied from Miskatonic
// University Registrar's `src/lib/server/db/index.ts`.
//
// It exists now only so `app.d.ts` (`App.Locals.db: AppDb`) type-checks while
// the scaffold has no database yet.

export type AppDb = unknown;
