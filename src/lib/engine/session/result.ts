/**
 * Generic pure-reducer result shape (controller amendment 1 — frozen). `S` is
 * the caller's success state, `E` its event type, `R` its rejection type.
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

export type ReduceResult<S, E, R> = { ok: true; state: S; events: E[] } | { ok: false; rejection: R };
