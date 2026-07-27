# Alpha Beta-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn every visitor that Guild Book is alpha software whose data may be lost, and give the owner an admin-only page showing who signed up, what they built, and whether they came back — before a cohort of beta testers arrives.

**Architecture:** Activity tracking widens the `users` row-existence `select` that the Auth.js `jwt` callback already performs on every authenticated request, so it costs no extra query and writes at most once per user per day. The decision of *whether* to write is a pure function with no DB or clock access, unit-tested independently. The admin page is a server load guarded by an env-var email allowlist that 404s (never 403s) for non-admins. The banner is a root-layout component rendered server-side.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript strict, Drizzle ORM, SQLite (local) / Cloudflare D1 (production), Auth.js, Vitest, Playwright.

**Design spec:** `docs/superpowers/specs/2026-07-27-alpha-beta-readiness-design.md`

## Global Constraints

- **Campaigns stay dark.** Do not set `CAMPAIGNS_ENABLED` or add beta users to `CAMPAIGNS_PILOT_USER_IDS`. No task in this plan touches campaign, session, or tarot code.
- **The rate limiter in `src/hooks.server.ts` is knowingly left as-is.** Its per-isolate `Map` is Increment 5 Task 1's problem and depends on the Pages → Workers migration. Do not "fix" it here.
- **An activity write must never be able to sign a user out.** Every write added in Task 4 is wrapped in `try`/`catch`. Returning `null` from the `jwt` callback invalidates the token — an analytics failure must never reach that path.
- **Non-admins get `error(404)`, never `error(403)` and never `error(401)`.** The `/admin` route must not disclose that it exists.
- **Admin identity resolves from the `users.email` column, never from `session.user.email`.** Only the stored column has passed `verifiedProviderEmail`.
- **`ADMIN_EMAILS` unset or empty means nobody is an admin.** Fail closed.
- Read every environment setting with the existing `getEnv(event, KEY)` helper from `$lib/server/auth`. Do not introduce `$env/static/*` or `$env/dynamic/*` — the repo reads nothing that way, because `getEnv` is what makes Cloudflare bindings and Node `process.env` share one code path.
- Archived and draft rows are **included and flagged** in every admin figure and table, never filtered out.
- Theme colours are oklch custom properties defined in both theme files. Never hardcode a colour in a component.
- No personal email address is committed to the repository.

---

### Task 1: Alpha banner, alert theme tokens, and layout wiring

**Files:**
- Create: `src/lib/components/layout/AlphaBanner.svelte`
- Modify: `src/lib/themes/parchment-light.css`
- Modify: `src/lib/themes/worm-dark.css`
- Modify: `src/routes/+layout.server.ts`
- Modify: `src/routes/+layout.svelte`
- Test: `tests/e2e/alpha-banner.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AlphaBanner` component accepting `{ feedbackUrl?: string | null }`. Root layout data gains `feedbackUrl: string | null`, which Task 2's error page also reads.

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/alpha-banner.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('alpha banner', () => {
	test('is visible on the home page', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
		await expect(page.getByTestId('alpha-banner')).toContainText('data may be lost');
	});

	test('dismissal hides it and survives navigation within the session', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'Dismiss alpha warning' }).click();
		await expect(page.getByTestId('alpha-banner')).toHaveCount(0);

		await page.goto('/rules');
		await expect(page.getByTestId('alpha-banner')).toHaveCount(0);
	});

	// The spec asks for coverage on a public `/s/[shareId]` page. Seeding a
	// shared character just for this would be disproportionate, and the
	// property under test is really "the root layout puts it on every page,
	// signed in or not" — which `/licensing` exercises identically. Task 6's
	// manual step covers a real share link.
	test('is visible on a public page with no session', async ({ page }) => {
		await page.goto('/licensing');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
	});

	test('returns in a fresh browser context', async ({ browser }) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
		await context.close();
	});

	test('does not cause horizontal overflow at 320px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();

		const overflows = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		);
		expect(overflows).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- alpha-banner`

Expected: FAIL — no element with `data-testid="alpha-banner"` exists.

- [ ] **Step 3: Add the alert tokens to the light theme**

In `src/lib/themes/parchment-light.css`, add two properties inside the existing `:root, [data-theme='parchment-light']` block, after `--accent`:

```css
	--alert: oklch(0.9 0.062 85);
	--alert-ink: oklch(0.3 0.06 60);
```

- [ ] **Step 4: Add the alert tokens to the dark theme**

In `src/lib/themes/worm-dark.css`, add two properties inside the existing `[data-theme='worm-dark']` block, after `--accent`:

```css
	--alert: oklch(0.29 0.045 75);
	--alert-ink: oklch(0.89 0.04 85);
```

Both pairs are a light background with dark ink and a dark background with light ink respectively, so each clears WCAG AA for body text.

- [ ] **Step 5: Create the banner component**

Create `src/lib/components/layout/AlphaBanner.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';

	let { feedbackUrl = null }: { feedbackUrl?: string | null } = $props();

	const STORAGE_KEY = 'gb-alpha-banner-dismissed';

	/**
	 * Rendered VISIBLE during SSR on purpose. A tester who already dismissed it
	 * sees a brief flash before `onMount` reads sessionStorage — that is the
	 * safe direction to err. Rendering hidden until JS confirms would instead
	 * flash *no warning* at every user on every page.
	 */
	let dismissed = $state(false);

	onMount(() => {
		try {
			if (sessionStorage.getItem(STORAGE_KEY) === '1') dismissed = true;
		} catch {
			// Private mode or blocked storage: stay visible rather than throw.
		}
	});

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Dismissal simply does not persist. Never throw from a click handler.
		}
	}
</script>

{#if !dismissed}
	<!-- Deliberately NO role="alert" and NO aria-live: either would interrupt
	     screen reader users on every navigation for the whole beta. Being first
	     in the DOM is what makes assistive technology reach it early. -->
	<div class="alpha-banner" data-testid="alpha-banner">
		<p>
			<strong>Alpha.</strong> Guild Book is early test software — expect rough edges, and
			<strong>your data may be lost</strong>.
			<a href="/characters">Export your adventurers</a> to keep your own copy.
			{#if feedbackUrl}
				<a href={feedbackUrl} target="_blank" rel="noopener noreferrer">Send feedback</a>
			{/if}
		</p>
		<button type="button" aria-label="Dismiss alpha warning" onclick={dismiss}>×</button>
	</div>
{/if}

<style>
	.alpha-banner {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		/* Wrapping, not overflow: the nav above already documents why 320px and
		 * 200% zoom are hard constraints in this layout. */
		flex-wrap: wrap;
		margin: 0 -1.25rem;
		padding: 0.6rem 1.25rem;
		background: var(--alert);
		color: var(--alert-ink);
		border-bottom: 1px solid color-mix(in oklab, var(--alert-ink) 25%, transparent);
		font-size: 0.85rem;
		line-height: 1.45;
	}
	.alpha-banner p {
		margin: 0;
		min-width: 0;
		flex: 1 1 16rem;
	}
	.alpha-banner a {
		color: inherit;
		text-decoration: underline;
	}
	.alpha-banner button {
		flex: none;
		border: none;
		background: none;
		padding: 0 0.25rem;
		color: inherit;
		font: inherit;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
	}
</style>
```

- [ ] **Step 6: Surface the feedback URL through the root layout load**

In `src/routes/+layout.server.ts`, import `getEnv` and add `feedbackUrl` to the returned object. The file becomes:

```ts
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/auth';
import { canAccessCampaignFeature, getCampaignFeatureConfig } from '$lib/server/campaign/config';

// Surfaces the signed-in session (if any) and the app version to every page.
export const load: LayoutServerLoad = async (event) => {
	const session = await event.locals.auth();
	const userId = session?.user?.id ?? null;
	return {
		appVersion: __APP_VERSION__,
		user: session?.user ? { name: session.user.name ?? null, email: session.user.email ?? null } : null,
		showCampaignsNav: Boolean(
			userId && canAccessCampaignFeature(getCampaignFeatureConfig(event), userId)
		),
		// A plain URL, safe to expose. Read through `getEnv` like every other
		// setting so Cloudflare bindings and process.env share one code path.
		feedbackUrl: getEnv(event, 'FEEDBACK_URL') ?? null
	};
};
```

- [ ] **Step 7: Render the banner in the root layout**

In `src/routes/+layout.svelte`, add the import next to the existing `ThemeToggle` import:

```ts
	import AlphaBanner from '$lib/components/layout/AlphaBanner.svelte';
```

Then make the banner the first child of `.site`, immediately above `<header class="site-header">`:

```svelte
<div class="site">
	<AlphaBanner feedbackUrl={data.feedbackUrl} />

	<header class="site-header">
```

- [ ] **Step 8: Run the E2E test to verify it passes**

Run: `npm run test:e2e -- alpha-banner`

Expected: PASS, all five tests.

- [ ] **Step 9: Verify types**

Run: `npm run check`

Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/components/layout/AlphaBanner.svelte src/lib/themes/parchment-light.css src/lib/themes/worm-dark.css src/routes/+layout.server.ts src/routes/+layout.svelte tests/e2e/alpha-banner.spec.ts
git commit -m "feat(beta): add dismissible alpha data-loss banner"
```

---

### Task 2: Custom error page

**Files:**
- Create: `src/routes/+error.svelte`
- Test: `tests/e2e/error-page.spec.ts`

**Interfaces:**
- Consumes: `feedbackUrl` from the root layout data added in Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/error-page.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('error page', () => {
	test('renders a branded 404 with a way back', async ({ page }) => {
		const response = await page.goto('/this-route-does-not-exist');
		expect(response?.status()).toBe(404);

		await expect(page.getByTestId('error-page')).toBeVisible();
		await expect(page.getByTestId('error-status')).toContainText('404');
		await expect(page.getByRole('link', { name: 'Back to Guild Book' })).toBeVisible();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- error-page`

Expected: FAIL — SvelteKit's default error page has no `data-testid="error-page"`.

- [ ] **Step 3: Create the error page**

Create `src/routes/+error.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';

	// `page.data` inherits the root layout's return value. If the layout load
	// itself failed, the key is simply absent — hence the optional access
	// rather than a required prop.
	let feedbackUrl = $derived((page.data?.feedbackUrl as string | null | undefined) ?? null);

	let heading = $derived(page.status === 404 ? 'That page is not here' : 'Something went wrong');
</script>

<svelte:head>
	<title>{page.status} — Guild Book</title>
</svelte:head>

<section class="error-page" data-testid="error-page">
	<p class="status" data-testid="error-status">{page.status}</p>
	<h1>{heading}</h1>
	<p class="detail">{page.error?.message ?? 'No further detail is available.'}</p>

	<p class="links">
		<a href="/">Back to Guild Book</a>
		<a href="/characters">My Adventurers</a>
		{#if feedbackUrl}
			<a href={feedbackUrl} target="_blank" rel="noopener noreferrer">Report this</a>
		{/if}
	</p>
</section>

<style>
	.error-page {
		max-width: 34rem;
		margin: 3rem auto;
		text-align: center;
	}
	.status {
		margin: 0;
		font-family: var(--font-display);
		font-size: 3.5rem;
		line-height: 1;
		color: var(--ink-soft);
	}
	.error-page h1 {
		font-family: var(--font-display);
		margin: 0.5rem 0 1rem;
	}
	.detail {
		color: var(--ink-soft);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 1.25rem;
		margin-top: 2rem;
	}
</style>
```

- [ ] **Step 4: Run the E2E test to verify it passes**

Run: `npm run test:e2e -- error-page`

Expected: PASS.

- [ ] **Step 5: Verify types**

Run: `npm run check`

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/+error.svelte tests/e2e/error-page.spec.ts
git commit -m "feat(beta): add branded error page"
```

---

### Task 3: Activity columns and the pure activity-patch function

**Files:**
- Modify: `src/lib/server/db/schema.ts:18-34`
- Create: `src/lib/server/db/migrations/0009_user_activity.sql` (generated)
- Create: `src/lib/server/admin/activity.ts`
- Test: `tests/unit/admin-activity.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `users.firstSeenAt: Date | null`, `users.lastSeenAt: Date | null`, `users.loginCount: number` on the Drizzle schema.
  - `export interface ActivityState { firstSeenAt: Date | null; lastSeenAt: Date | null; loginCount: number }`
  - `export interface ActivityPatch { firstSeenAt?: Date; lastSeenAt: Date; loginCount?: number }`
  - `export function utcDayKey(at: Date): string`
  - `export function activityPatch(input: { now: Date; isSignIn: boolean; current: ActivityState }): ActivityPatch | null`

  Task 4 calls `activityPatch` and applies the result. Task 6 reads the three columns.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/admin-activity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { activityPatch, utcDayKey, type ActivityState } from '$lib/server/admin/activity';

const NEVER_SEEN: ActivityState = { firstSeenAt: null, lastSeenAt: null, loginCount: 0 };

function seenAt(iso: string, loginCount = 3): ActivityState {
	return { firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date(iso), loginCount };
}

describe('utcDayKey', () => {
	it('keys by UTC calendar day, not local time', () => {
		expect(utcDayKey(new Date('2026-07-27T00:00:00Z'))).toBe('2026-07-27');
		expect(utcDayKey(new Date('2026-07-27T23:59:59Z'))).toBe('2026-07-27');
	});
});

describe('activityPatch', () => {
	it('returns null when resuming on the same UTC day', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		expect(activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T06:00:00Z') })).toBeNull();
	});

	it('returns a patch when resuming after the UTC day rolls over', () => {
		const now = new Date('2026-07-28T00:00:01Z');
		const patch = activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T23:59:59Z') });

		expect(patch).toEqual({ lastSeenAt: now });
	});

	it('does not increment loginCount when merely resuming', () => {
		const now = new Date('2026-07-28T09:00:00Z');
		const patch = activityPatch({ now, isSignIn: false, current: seenAt('2026-07-27T09:00:00Z', 5) });

		expect(patch?.loginCount).toBeUndefined();
	});

	it('increments loginCount on a sign-in even on the same day', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const patch = activityPatch({ now, isSignIn: true, current: seenAt('2026-07-27T06:00:00Z', 5) });

		expect(patch).toEqual({ lastSeenAt: now, loginCount: 6 });
	});

	it('sets firstSeenAt only when it is currently null', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const first = activityPatch({ now, isSignIn: true, current: NEVER_SEEN });
		expect(first).toEqual({ lastSeenAt: now, firstSeenAt: now, loginCount: 1 });

		const later = activityPatch({ now, isSignIn: true, current: seenAt('2026-07-27T06:00:00Z') });
		expect(later?.firstSeenAt).toBeUndefined();
	});

	it('patches a pre-migration row whose lastSeenAt is null', () => {
		const now = new Date('2026-07-27T18:00:00Z');
		const patch = activityPatch({
			now,
			isSignIn: false,
			current: { firstSeenAt: null, lastSeenAt: null, loginCount: 0 }
		});

		expect(patch).toEqual({ lastSeenAt: now, firstSeenAt: now });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/admin-activity.test.ts`

Expected: FAIL — cannot resolve `$lib/server/admin/activity`.

- [ ] **Step 3: Write the pure function**

Create `src/lib/server/admin/activity.ts`:

```ts
/**
 * Decides whether a user's activity columns need writing. Pure by design — no
 * DB access, no clock read of its own — so the day-boundary behaviour is
 * exhaustively testable. `auth-policy.ts` supplies `now` and applies the
 * result.
 */

export interface ActivityState {
	firstSeenAt: Date | null;
	lastSeenAt: Date | null;
	loginCount: number;
}

export interface ActivityPatch {
	firstSeenAt?: Date;
	lastSeenAt: Date;
	loginCount?: number;
}

/** UTC, not local: keeps this deterministic in tests and stable across hosts. */
export function utcDayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

export function activityPatch(input: {
	now: Date;
	isSignIn: boolean;
	current: ActivityState;
}): ActivityPatch | null {
	const { now, isSignIn, current } = input;

	// The overwhelmingly common case: an already-signed-in user making another
	// request today. Returning null here is what caps this at one write per
	// user per day no matter how much traffic they generate.
	if (!isSignIn && current.lastSeenAt && utcDayKey(current.lastSeenAt) === utcDayKey(now)) {
		return null;
	}

	const patch: ActivityPatch = { lastSeenAt: now };
	if (!current.firstSeenAt) patch.firstSeenAt = now;
	if (isSignIn) patch.loginCount = current.loginCount + 1;
	return patch;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/admin-activity.test.ts`

Expected: PASS, all seven tests.

- [ ] **Step 5: Add the schema columns**

In `src/lib/server/db/schema.ts`, add three columns to the `users` table definition, after `image`:

```ts
		image: text('image'),
		/** Beta activity signals. Nullable/defaulted so the migration is additive
		 * and needs no backfill — pre-migration sign-ins are unrecoverable. */
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
		loginCount: integer('login_count').notNull().default(0)
```

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate --name=user_activity`

Expected: creates `src/lib/server/db/migrations/0009_user_activity.sql` and updates `src/lib/server/db/migrations/meta/_journal.json`.

Open the generated SQL and confirm it contains exactly three additive `ALTER TABLE` statements and no table rebuild:

```sql
ALTER TABLE `users` ADD `first_seen_at` integer;
ALTER TABLE `users` ADD `last_seen_at` integer;
ALTER TABLE `users` ADD `login_count` integer DEFAULT 0 NOT NULL;
```

If the generated file drops and recreates `users`, **stop** — that would destroy accounts on D1. Re-check the column definitions in Step 5 against the existing ones before continuing.

- [ ] **Step 7: Apply the migration locally**

Run: `npm run db:migrate:d1:local`

Expected: applies `0009_user_activity` and exits 0.

- [ ] **Step 8: Verify types and the full unit suite**

Run: `npm run check && npm test`

Expected: `check` clean, and the full suite green. `tests/unit/auth-lifecycle.test.ts` still passes at this point because `auth-policy.ts` does not yet read the new columns — Task 4 is where that test needs updating.

- [ ] **Step 9: Commit**

```bash
git add src/lib/server/db/schema.ts src/lib/server/db/migrations src/lib/server/admin/activity.ts tests/unit/admin-activity.test.ts
git commit -m "feat(beta): add user activity columns and patch logic"
```

---

### Task 4: Record activity from the auth callback

**Files:**
- Modify: `src/lib/server/auth-policy.ts:11-41`
- Modify: `tests/unit/auth-lifecycle.test.ts:21-31`
- Test: `tests/unit/auth-activity.test.ts`

**Interfaces:**
- Consumes: `activityPatch`, `ActivityState` from Task 3; the `users` columns from Task 3.
- Produces: populated `first_seen_at` / `last_seen_at` / `login_count` values, which Task 6 reads.

**Critical:** `tests/unit/auth-lifecycle.test.ts` builds its database by reading migrations `0000`, `0001`, and `0002` by explicit filename. Once `createAuthCallbacks` selects the new columns, that test fails with `no such column: first_seen_at` until Step 5 adds the new migration to it. This is expected, not a regression.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/auth-activity.test.ts`:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { users } from '$lib/server/db/schema';
import { AUTH_SESSION_VERSION, createAuthCallbacks } from '$lib/server/auth-policy';

function makeDb(): { db: AppDb; sqlite: Database.Database } {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((n) => n.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
	return { db: drizzle(sqlite, { schema }) as unknown as AppDb, sqlite };
}

/** The `jwt` callback's signature is wide; tests only ever pass these fields. */
type JwtArgs = Parameters<NonNullable<ReturnType<typeof createAuthCallbacks>['jwt']>>[0];

describe('auth activity recording', () => {
	let db: AppDb;

	beforeEach(() => {
		({ db } = makeDb());
	});

	async function readUser(id: string) {
		return db
			.select({
				firstSeenAt: users.firstSeenAt,
				lastSeenAt: users.lastSeenAt,
				loginCount: users.loginCount
			})
			.from(users)
			.where(eq(users.id, id))
			.get();
	}

	it('increments loginCount and stamps firstSeenAt on sign-in', async () => {
		await db.insert(users).values({ id: 'user-a', email: 'a@example.test' });
		const callbacks = createAuthCallbacks(db);

		await callbacks.jwt!({ token: {}, user: { id: 'user-a' } } as unknown as JwtArgs);

		const row = await readUser('user-a');
		expect(row?.loginCount).toBe(1);
		expect(row?.firstSeenAt).toBeInstanceOf(Date);
		expect(row?.lastSeenAt).toBeInstanceOf(Date);
	});

	it('stamps lastSeenAt without incrementing loginCount when resuming', async () => {
		await db.insert(users).values({ id: 'user-b', email: 'b@example.test' });
		const callbacks = createAuthCallbacks(db);

		const token = { sub: 'user-b', sessionVersion: AUTH_SESSION_VERSION };
		const result = await callbacks.jwt!({ token } as unknown as JwtArgs);

		expect(result).toBe(token);
		const row = await readUser('user-b');
		expect(row?.loginCount).toBe(0);
		expect(row?.lastSeenAt).toBeInstanceOf(Date);
	});

	it('keeps the session valid when the activity write throws', async () => {
		await db.insert(users).values({ id: 'user-c', email: 'c@example.test' });
		const callbacks = createAuthCallbacks(db);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(db, 'update').mockImplementation(() => {
			throw new Error('D1 unavailable');
		});

		const token = { sub: 'user-c', sessionVersion: AUTH_SESSION_VERSION };
		const result = await callbacks.jwt!({ token } as unknown as JwtArgs);

		// The whole point: an analytics failure must never sign a user out.
		expect(result).toBe(token);
		expect(warn).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it('still invalidates a token whose user row is gone', async () => {
		const callbacks = createAuthCallbacks(db);

		const result = await callbacks.jwt!({
			token: { sub: 'user-missing', sessionVersion: AUTH_SESSION_VERSION }
		} as unknown as JwtArgs);

		expect(result).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/auth-activity.test.ts`

Expected: FAIL — `loginCount` is `0` after sign-in and `lastSeenAt` is null, because nothing writes them yet.

- [ ] **Step 3: Record activity in the auth callbacks**

Rewrite `src/lib/server/auth-policy.ts`'s imports and `createAuthCallbacks`. The imports become:

```ts
import type { AuthConfig } from '@auth/core';
import type { DiscordProfile } from '@auth/core/providers/discord';
import type { GoogleProfile } from '@auth/core/providers/google';
import { eq } from 'drizzle-orm';
import type { AppDb } from './db';
import { users } from './db/schema';
import { activityPatch, type ActivityState } from './admin/activity';
```

Add this helper above `createAuthCallbacks`:

```ts
/**
 * Best-effort beta activity write. Failure is swallowed on purpose: the caller
 * is the `jwt` callback, and throwing (or letting a rejection escape) there
 * would invalidate the token and sign the user out. No analytics figure is
 * worth that.
 */
async function recordActivity(
	db: AppDb,
	userId: string,
	isSignIn: boolean,
	current: ActivityState
): Promise<void> {
	try {
		const patch = activityPatch({ now: new Date(), isSignIn, current });
		if (!patch) return;
		await db.update(users).set(patch).where(eq(users.id, userId));
	} catch (err) {
		console.warn('[auth] activity write failed:', (err as Error)?.message ?? err);
	}
}
```

Then replace the `jwt` callback body with:

```ts
		async jwt({ token, user }) {
			if (user?.id) {
				// With the adapter, Auth.js supplies the durable local users.id.
				token.sub = user.id;
				token.sessionVersion = AUTH_SESSION_VERSION;
				// A sign-in happens at most once per token lifetime, so the extra
				// read here is cheap and keeps every decision in the tested pure
				// function rather than splitting it across SQL expressions.
				const current = await db
					.select({
						firstSeenAt: users.firstSeenAt,
						lastSeenAt: users.lastSeenAt,
						loginCount: users.loginCount
					})
					.from(users)
					.where(eq(users.id, user.id))
					.get();
				await recordActivity(
					db,
					user.id,
					true,
					current ?? { firstSeenAt: null, lastSeenAt: null, loginCount: 0 }
				);
			} else if (token.sessionVersion !== AUTH_SESSION_VERSION) {
				// Invalidate legacy JWTs whose `sub` held the provider account id.
				// Rotating AUTH_SECRET at rollout remains recommended, but correctness
				// does not depend on that operational step.
				return null;
			} else if (token.sub) {
				// A signed JWT must not outlive its durable local user. This also keeps
				// the application shell and protected API routes in agreement after an
				// account is removed. The activity columns ride along on this
				// already-required lookup, so tracking costs no extra query.
				const existing = await db
					.select({
						id: users.id,
						firstSeenAt: users.firstSeenAt,
						lastSeenAt: users.lastSeenAt,
						loginCount: users.loginCount
					})
					.from(users)
					.where(eq(users.id, token.sub))
					.get();
				if (!existing) return null;
				await recordActivity(db, existing.id, false, existing);
			}
			return token;
		},
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm test -- tests/unit/auth-activity.test.ts`

Expected: PASS, all four tests.

- [ ] **Step 5: Repair the auth-lifecycle test's migration set**

`tests/unit/auth-lifecycle.test.ts` now fails with `no such column: first_seen_at`. Add the new migration alongside the three it already reads, after the `normalizedEmailMigration` constant:

```ts
const userActivityMigration = readFileSync(
	new URL('../../src/lib/server/db/migrations/0009_user_activity.sql', import.meta.url),
	'utf8'
);
```

Then extend the existing exec block at `tests/unit/auth-lifecycle.test.ts:109-111`, which currently reads:

```ts
		sqlite.exec(baseMigration);
		sqlite.exec(authMigration);
		sqlite.exec(normalizedEmailMigration);
```

so that it becomes:

```ts
		sqlite.exec(baseMigration);
		sqlite.exec(authMigration);
		sqlite.exec(normalizedEmailMigration);
		sqlite.exec(userActivityMigration);
```

Order matters: `0009` alters the `users` table that `0000` creates, so it must run last.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`

Expected: PASS. Confirm `tests/unit/auth-lifecycle.test.ts` is green — that is the check that Step 5 landed correctly.

- [ ] **Step 7: Verify types**

Run: `npm run check`

Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/auth-policy.ts tests/unit/auth-activity.test.ts tests/unit/auth-lifecycle.test.ts
git commit -m "feat(beta): record sign-in and last-seen activity"
```

---

### Task 5: Admin allowlist and route guard

**Files:**
- Create: `src/lib/server/admin/config.ts`
- Test: `tests/unit/admin-config.test.ts`

**Interfaces:**
- Consumes: `getEnv`, `getUserId` from `$lib/server/auth`; `getDb` from `$lib/server/db`; the `users` schema.
- Produces:
  - `export interface AdminConfig { adminEmails: ReadonlySet<string> }`
  - `export function getAdminConfig(event: RequestEvent): AdminConfig`
  - `export function isAdminEmail(config: AdminConfig, email: string | null | undefined): boolean`
  - `export async function requireAdmin(event: RequestEvent): Promise<{ userId: string; email: string }>` — throws `error(404)` for anyone who is not an admin.

  Task 6's page load calls `requireAdmin`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/admin-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAdminConfig, isAdminEmail } from '$lib/server/admin/config';
import type { RequestEvent } from '@sveltejs/kit';

/** `getEnv` reads `event.platform.env` first, which is all these tests need. */
function eventWith(env: Record<string, string>): RequestEvent {
	return { platform: { env } } as unknown as RequestEvent;
}

describe('getAdminConfig', () => {
	it('yields an empty set when ADMIN_EMAILS is unset', () => {
		expect(getAdminConfig(eventWith({})).adminEmails.size).toBe(0);
	});

	it('yields an empty set when ADMIN_EMAILS is blank or only separators', () => {
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: '   ' })).adminEmails.size).toBe(0);
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: ',,' })).adminEmails.size).toBe(0);
	});

	it('splits, trims, and lowercases entries', () => {
		const config = getAdminConfig(eventWith({ ADMIN_EMAILS: ' Owner@Example.Test , two@example.test' }));

		expect([...config.adminEmails].sort()).toEqual(['owner@example.test', 'two@example.test']);
	});
});

describe('isAdminEmail', () => {
	const config = getAdminConfig(eventWith({ ADMIN_EMAILS: 'owner@example.test' }));

	it('matches regardless of casing or surrounding whitespace', () => {
		expect(isAdminEmail(config, 'Owner@Example.Test')).toBe(true);
		expect(isAdminEmail(config, ' owner@example.test ')).toBe(true);
	});

	it('rejects a null, undefined, or empty email', () => {
		expect(isAdminEmail(config, null)).toBe(false);
		expect(isAdminEmail(config, undefined)).toBe(false);
		expect(isAdminEmail(config, '')).toBe(false);
	});

	it('rejects a substring or superstring of an admin address', () => {
		expect(isAdminEmail(config, 'owner@example.tes')).toBe(false);
		expect(isAdminEmail(config, 'notowner@example.test')).toBe(false);
		expect(isAdminEmail(config, 'owner@example.test.evil.test')).toBe(false);
	});

	it('fails closed against an empty allowlist', () => {
		const empty = getAdminConfig(eventWith({}));
		expect(isAdminEmail(empty, 'owner@example.test')).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/admin-config.test.ts`

Expected: FAIL — cannot resolve `$lib/server/admin/config`.

- [ ] **Step 3: Write the config module**

Create `src/lib/server/admin/config.ts`:

```ts
import { error, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getEnv, getUserId } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { users } from '$lib/server/db/schema';

export interface AdminConfig {
	adminEmails: ReadonlySet<string>;
}

/**
 * Server-only admin rollout configuration; never return this in page data.
 * An unset or empty `ADMIN_EMAILS` yields an empty set, so the default posture
 * is that nobody is an admin.
 */
export function getAdminConfig(event: RequestEvent): AdminConfig {
	const adminEmails = new Set(
		(getEnv(event, 'ADMIN_EMAILS') ?? '')
			.split(',')
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean)
	);

	return { adminEmails };
}

export function isAdminEmail(config: AdminConfig, email: string | null | undefined): boolean {
	if (!email) return false;
	return config.adminEmails.has(email.trim().toLowerCase());
}

/**
 * Gate an admin-only route. Throws 404 — never 401 or 403 — for anonymous
 * users and signed-in non-admins alike, so the route's existence is not
 * disclosed to a curious beta tester.
 *
 * The email is resolved from the `users` row rather than `session.user.email`:
 * only the stored column has been through `verifiedProviderEmail`, so only it
 * is safe to compare against the allowlist.
 */
export async function requireAdmin(
	event: RequestEvent
): Promise<{ userId: string; email: string }> {
	const notFound = () => error(404, 'Not found');

	const userId = await getUserId(event);
	if (!userId) throw notFound();

	const db = await getDb(event);
	const row = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.get();

	if (!isAdminEmail(getAdminConfig(event), row?.email)) throw notFound();

	return { userId, email: row!.email! };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/admin-config.test.ts`

Expected: PASS, all eight tests.

- [ ] **Step 5: Verify types**

Run: `npm run check`

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/admin/config.ts tests/unit/admin-config.test.ts
git commit -m "feat(beta): add admin allowlist and route guard"
```

---

### Task 6: The `/admin` page

**Files:**
- Create: `src/routes/admin/+page.server.ts`
- Create: `src/routes/admin/+page.svelte`
- Test: `tests/integration/admin-access.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` from Task 5; the activity columns from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/admin-access.test.ts`:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getUserId: vi.fn(),
	getEnv: vi.fn(
		(event: { platform?: { env?: Record<string, string> } }, key: string) =>
			event.platform?.env?.[key]
	),
	getDb: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ getUserId: mocks.getUserId, getEnv: mocks.getEnv }));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));

import { load } from '../../src/routes/admin/+page.server';

const ADMIN_EMAIL = 'owner@example.test';

function adminEvent(searchParams: Record<string, string> = {}): RequestEvent {
	const url = new URL('http://localhost/admin');
	for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
	return { url, platform: { env: { ADMIN_EMAILS: ADMIN_EMAIL } } } as unknown as RequestEvent;
}

async function statusOf(run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
		return 200;
	} catch (err) {
		return (err as { status?: number }).status ?? 500;
	}
}

describe('admin page access', () => {
	let sqlite: Database.Database;

	beforeEach(() => {
		vi.clearAllMocks();
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		const directory = join(process.cwd(), 'src/lib/server/db/migrations');
		for (const filename of readdirSync(directory).filter((n) => n.endsWith('.sql')).sort()) {
			sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
		}

		sqlite
			.prepare('INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)')
			.run('admin-user', 'Owner', ADMIN_EMAIL, 4);
		sqlite
			.prepare('INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)')
			.run('plain-user', 'Tester', 'tester@example.test', 1);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-1', 'plain-user', 'Old Tom', 'Human', 'Fighter', '{}', 0, 0, 1000, 1000);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-2', 'plain-user', 'Draft Dan', 'Elf', 'Thief', '{}', 1, 0, 1000, 1000);

		mocks.getDb.mockResolvedValue(drizzle(sqlite, { schema }));
	});

	it('404s for an anonymous visitor', async () => {
		mocks.getUserId.mockResolvedValue(null);
		expect(await statusOf(() => load(adminEvent() as never))).toBe(404);
	});

	it('404s for a signed-in non-admin', async () => {
		mocks.getUserId.mockResolvedValue('plain-user');
		expect(await statusOf(() => load(adminEvent() as never))).toBe(404);
	});

	it('404s when ADMIN_EMAILS is unset', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const event = { url: new URL('http://localhost/admin'), platform: { env: {} } };
		expect(await statusOf(() => load(event as never))).toBe(404);
	});

	it('404s when the session claims an admin email the users row does not have', async () => {
		// The spoof case: only the stored column is authoritative.
		mocks.getUserId.mockResolvedValue('plain-user');
		const event = {
			url: new URL('http://localhost/admin'),
			platform: { env: { ADMIN_EMAILS: ADMIN_EMAIL } },
			locals: { auth: async () => ({ user: { id: 'plain-user', email: ADMIN_EMAIL } }) }
		};
		expect(await statusOf(() => load(event as never))).toBe(404);
	});

	it('returns summary figures and rows for an admin', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(adminEvent() as never)) as {
			summary: Record<string, number>;
			users: unknown[];
			characters: unknown[];
		};

		expect(data.summary.totalUsers).toBe(2);
		expect(data.summary.totalCharacters).toBe(2);
		expect(data.summary.draftCharacters).toBe(1);
		expect(data.summary.completedCharacters).toBe(1);
		expect(data.summary.totalDenizens).toBe(0);
		expect(data.users).toHaveLength(2);
		expect(data.characters).toHaveLength(2);
	});

	it('clamps unrecognised sort and page params instead of erroring', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(
			adminEvent({ userSort: 'DROP TABLE users', usersPage: '-9', charactersPage: 'abc' }) as never
		)) as { users: unknown[]; usersPage: number };

		expect(data.usersPage).toBe(1);
		expect(data.users).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/admin-access.test.ts`

Expected: FAIL — cannot resolve `../../src/routes/admin/+page.server`.

- [ ] **Step 3: Write the page load**

Create `src/routes/admin/+page.server.ts`:

```ts
import { count, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/admin/config';
import { characters, denizens, users } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sorting is an allowlist, not a passthrough: the request value selects a
 * pre-built Drizzle expression and never reaches `orderBy` itself.
 * SQLite sorts NULLs as smaller than any value, so `desc()` naturally places
 * never-seen users last.
 */
const USER_SORTS = {
	lastSeen: desc(users.lastSeenAt),
	firstSeen: desc(users.firstSeenAt),
	logins: desc(users.loginCount),
	name: users.name
} as const;

const CHARACTER_SORTS = {
	created: desc(characters.createdAt),
	updated: desc(characters.updatedAt),
	name: characters.name
} as const;

type UserSort = keyof typeof USER_SORTS;
type CharacterSort = keyof typeof CHARACTER_SORTS;

/** 1-based in the URL, 0-based as an offset. Anything unparseable is page 1. */
function readPage(url: URL, key: string): number {
	const raw = Number.parseInt(url.searchParams.get(key) ?? '', 10);
	return Number.isFinite(raw) && raw > 1 ? raw : 1;
}

function readSort<K extends string>(url: URL, key: string, allowed: Record<K, unknown>, fallback: K): K {
	const raw = url.searchParams.get(key);
	return raw !== null && Object.prototype.hasOwnProperty.call(allowed, raw) ? (raw as K) : fallback;
}

export const load: PageServerLoad = async (event) => {
	await requireAdmin(event);

	const db = await getDb(event);
	const since = new Date(Date.now() - SEVEN_DAYS_MS);

	const usersPage = readPage(event.url, 'usersPage');
	const charactersPage = readPage(event.url, 'charactersPage');
	const userSort = readSort<UserSort>(event.url, 'userSort', USER_SORTS, 'lastSeen');
	const characterSort = readSort<CharacterSort>(
		event.url,
		'characterSort',
		CHARACTER_SORTS,
		'created'
	);

	// Every figure is a SQL aggregate — no query pulls rows into JS to count
	// them. Each `.get()` is awaited inline rather than through a helper:
	// better-sqlite3 resolves it synchronously and D1 returns a promise, and
	// `await` handles both, but a helper typed as `Promise<T>` would not.
	const totalUsers =
		(await db.select({ value: count() }).from(users).get())?.value ?? 0;
	const activeUsers =
		(await db.select({ value: count() }).from(users).where(gte(users.lastSeenAt, since)).get())
			?.value ?? 0;
	const totalCharacters =
		(await db.select({ value: count() }).from(characters).get())?.value ?? 0;
	const draftCharacters =
		(await db.select({ value: count() }).from(characters).where(eq(characters.isDraft, true)).get())
			?.value ?? 0;
	const newCharacters =
		(await db
			.select({ value: count() })
			.from(characters)
			.where(gte(characters.createdAt, since))
			.get())?.value ?? 0;
	const totalDenizens =
		(await db.select({ value: count() }).from(denizens).get())?.value ?? 0;

	const userRows = await db
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			firstSeenAt: users.firstSeenAt,
			lastSeenAt: users.lastSeenAt,
			loginCount: users.loginCount,
			characterCount: sql<number>`(select count(*) from ${characters} where ${characters.userId} = ${users.id})`
		})
		.from(users)
		.orderBy(USER_SORTS[userSort])
		.limit(PAGE_SIZE)
		.offset((usersPage - 1) * PAGE_SIZE)
		.all();

	const characterRows = await db
		.select({
			id: characters.id,
			name: characters.name,
			kith: characters.kith,
			path: characters.path,
			isDraft: characters.isDraft,
			isArchived: characters.isArchived,
			createdAt: characters.createdAt,
			updatedAt: characters.updatedAt,
			ownerName: users.name,
			ownerEmail: users.email
		})
		.from(characters)
		.innerJoin(users, eq(characters.userId, users.id))
		.orderBy(CHARACTER_SORTS[characterSort])
		.limit(PAGE_SIZE)
		.offset((charactersPage - 1) * PAGE_SIZE)
		.all();

	return {
		summary: {
			totalUsers,
			activeUsers,
			totalCharacters,
			draftCharacters,
			completedCharacters: totalCharacters - draftCharacters,
			newCharacters,
			totalDenizens
		},
		users: userRows,
		characters: characterRows,
		usersPage,
		charactersPage,
		userSort,
		characterSort,
		pageSize: PAGE_SIZE
	};
};
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `npm test -- tests/integration/admin-access.test.ts`

Expected: PASS, all six tests.

- [ ] **Step 5: Write the page component**

Create `src/routes/admin/+page.svelte`:

```svelte
<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

	function when(value: Date | null): string {
		return value ? dateFormat.format(value) : '—';
	}

	let tiles = $derived([
		{ label: 'Users', value: data.summary.totalUsers },
		{ label: 'Active (7d)', value: data.summary.activeUsers },
		{ label: 'Adventurers', value: data.summary.totalCharacters },
		{ label: 'Complete', value: data.summary.completedCharacters },
		{ label: 'Drafts', value: data.summary.draftCharacters },
		{ label: 'New (7d)', value: data.summary.newCharacters },
		{ label: 'Denizens', value: data.summary.totalDenizens }
	]);

	function pageHref(key: string, value: number): string {
		const params = new URLSearchParams({
			usersPage: String(data.usersPage),
			charactersPage: String(data.charactersPage),
			userSort: data.userSort,
			characterSort: data.characterSort
		});
		params.set(key, String(value));
		return `?${params}`;
	}
</script>

<svelte:head>
	<title>Admin — Guild Book</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1>Admin</h1>

<ul class="tiles">
	{#each tiles as tile (tile.label)}
		<li><span class="value">{tile.value}</span><span class="label">{tile.label}</span></li>
	{/each}
</ul>

<h2>Users</h2>
<div class="scroller">
	<table>
		<thead>
			<tr>
				<th>Name</th><th>Email</th><th>First seen</th><th>Last seen</th>
				<th>Logins</th><th>Adventurers</th>
			</tr>
		</thead>
		<tbody>
			{#each data.users as row (row.id)}
				<tr>
					<td>{row.name ?? '—'}</td>
					<td>{row.email ?? '—'}</td>
					<td>{when(row.firstSeenAt)}</td>
					<td>{when(row.lastSeenAt)}</td>
					<td>{row.loginCount}</td>
					<td>{row.characterCount}</td>
				</tr>
			{:else}
				<tr><td colspan="6">No users yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<nav class="pager">
	{#if data.usersPage > 1}<a href={pageHref('usersPage', data.usersPage - 1)}>Previous</a>{/if}
	<span>Page {data.usersPage}</span>
	{#if data.users.length === data.pageSize}
		<a href={pageHref('usersPage', data.usersPage + 1)}>Next</a>
	{/if}
</nav>

<h2>Adventurers</h2>
<div class="scroller">
	<table>
		<thead>
			<tr>
				<th>Name</th><th>Kith</th><th>Path</th><th>Owner</th>
				<th>State</th><th>Created</th><th>Updated</th>
			</tr>
		</thead>
		<tbody>
			{#each data.characters as row (row.id)}
				<tr>
					<td>{row.name || '—'}</td>
					<td>{row.kith || '—'}</td>
					<td>{row.path || '—'}</td>
					<td>{row.ownerName ?? row.ownerEmail ?? '—'}</td>
					<td>
						{row.isDraft ? 'Draft' : 'Complete'}{row.isArchived ? ' · Archived' : ''}
					</td>
					<td>{when(row.createdAt)}</td>
					<td>{when(row.updatedAt)}</td>
				</tr>
			{:else}
				<tr><td colspan="7">No adventurers yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<nav class="pager">
	{#if data.charactersPage > 1}
		<a href={pageHref('charactersPage', data.charactersPage - 1)}>Previous</a>
	{/if}
	<span>Page {data.charactersPage}</span>
	{#if data.characters.length === data.pageSize}
		<a href={pageHref('charactersPage', data.charactersPage + 1)}>Next</a>
	{/if}
</nav>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		list-style: none;
		margin: 1.5rem 0 2.5rem;
		padding: 0;
	}
	.tiles li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem;
		background: var(--surface);
		border: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
		border-radius: 0.4rem;
	}
	.value {
		font-family: var(--font-display);
		font-size: 1.75rem;
		line-height: 1;
	}
	.label {
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	/* Wide tables scroll inside their own container; the page body never
	 * scrolls sideways. */
	.scroller {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	th,
	td {
		text-align: left;
		padding: 0.45rem 0.75rem 0.45rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	th {
		font-family: var(--font-subhead);
		color: var(--ink-soft);
	}
	.pager {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin: 0.75rem 0 2.5rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
```

- [ ] **Step 6: Verify types and the full suite**

Run: `npm run check && npm test`

Expected: `check` clean, full suite green.

- [ ] **Step 7: Manually verify the gate**

Run `npm run dev` with `ADMIN_EMAILS` unset and visit `/admin`. Expected: the Task 2 error page showing 404.

Stop the server, set `ADMIN_EMAILS` to your own signed-in address, restart, and revisit. Expected: the dashboard, with your own account listed and a login count of at least 1.

Then share a character from `/characters`, open the resulting `/s/<shareId>` URL, and confirm the alpha banner is present there too — the one public surface the Task 1 E2E test substitutes `/licensing` for.

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin tests/integration/admin-access.test.ts
git commit -m "feat(beta): add admin overview page"
```

---

### Task 7: Backup, restore rehearsal, and deployment notes

**Files:**
- Create: `docs/operations/backup-restore.md`
- Modify: `DEPLOY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing. Documentation and an operational rehearsal only.
- Produces: nothing later tasks depend on.

**No production database is restored, overwritten, or recreated by this task.**

- [ ] **Step 1: Capture a pre-beta snapshot**

Run:

```bash
mkdir -p .backups
npx wrangler d1 export guild-book-db --remote --output .backups/guild-book-prebeta.sql
```

Expected: a `.sql` file containing `CREATE TABLE` statements for `users`, `characters`, and `denizens`.

Confirm `.backups/` is ignored by git before continuing — the dump contains real user emails:

```bash
git check-ignore .backups/guild-book-prebeta.sql
```

If that prints nothing, add `.backups/` to `.gitignore` and commit that change before going any further. **Never commit a database dump.**

- [ ] **Step 2: Confirm Time Travel coverage**

Run: `npx wrangler d1 time-travel info guild-book-db`

Record the reported restore window and the current bookmark. If the command reports no bookmark, note that in the runbook rather than assuming coverage exists.

- [ ] **Step 3: Rehearse a restore against a scratch database**

An unrehearsed backup is not a backup. Create a throwaway database, load the snapshot into it, and confirm the data arrives:

```bash
npx wrangler d1 create guild-book-restore-drill
npx wrangler d1 execute guild-book-restore-drill --remote --file=.backups/guild-book-prebeta.sql
npx wrangler d1 execute guild-book-restore-drill --remote --command="SELECT count(*) FROM users;"
```

Expected: the count matches the production user count from `/admin`.

Then delete the drill database:

```bash
npx wrangler d1 delete guild-book-restore-drill
```

Double-check the name on that delete command before running it.

- [ ] **Step 4: Write the runbook**

Create `docs/operations/backup-restore.md` covering:

- the pre-beta snapshot command and where the file was stored (path only — never the contents);
- the Time Travel window and bookmark observed in Step 2, with the date observed;
- the exact `wrangler d1 time-travel restore` invocation for the production database, marked clearly as destructive;
- the drill result from Step 3: database name used, row count compared, and confirmation it was deleted;
- an explicit note that `first_seen_at`, `last_seen_at`, and `login_count` cannot be reconstructed from a pre-migration backup.

No secrets, no invite tokens, no user emails.

- [ ] **Step 5: Add the environment variables to DEPLOY.md**

In `DEPLOY.md`'s environment-variables table, add two rows:

| Variable | Value |
| --- | --- |
| `ADMIN_EMAILS` | Comma-separated admin addresses. Unset means nobody can reach `/admin`. |
| `FEEDBACK_URL` | Optional. Where the banner's "Send feedback" link points. Omit to hide the link. |

Add a short "Backup and restore" section pointing at `docs/operations/backup-restore.md`.

- [ ] **Step 6: Update the changelog**

Add an `Added` entry under Unreleased in `CHANGELOG.md`, in Keep a Changelog format, covering the alpha banner, the error page, activity tracking, and the admin overview.

- [ ] **Step 7: Commit**

```bash
git add docs/operations/backup-restore.md DEPLOY.md CHANGELOG.md
git commit -m "docs(beta): document backup, restore drill, and admin config"
```

---

## Deployment checklist

Not a code task — the ordering that makes the data exist when the testers arrive.

- [ ] Deploy Tasks 1–2 (banner and error page). No migration, safe any time.
- [ ] Run `npm run db:migrate:d1:remote` to apply `0009_user_activity` to production.
- [ ] Deploy Tasks 3–6. **This must land before the beta invitations go out** — `login_count` and `last_seen_at` cannot be backfilled, so every sign-in before this deploy is unrecorded.
- [ ] Set `ADMIN_EMAILS` in the Cloudflare project's production variables, then confirm `/admin` loads for you and 404s in a private window.
- [ ] Optionally set `FEEDBACK_URL` once the destination exists.
- [ ] Confirm `CAMPAIGNS_ENABLED` is still unset.
