import { count, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/admin/config';
import { characters, denizens, users } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Any finite integer is otherwise a legal `?usersPage=`/`?charactersPage=`
 * value, so an astronomically large one turns `(page - 1) * PAGE_SIZE` into
 * an unsafe-integer OFFSET that better-sqlite3/D1 reject outright — an error,
 * not the empty page the spec calls for past the real last page. This cap is
 * far past any page count this table will ever reach while keeping the
 * resulting offset a safe integer.
 */
const MAX_PAGE = 100_000;

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

/**
 * 1-based in the URL, 0-based as an offset. Anything unparseable is page 1;
 * anything past `MAX_PAGE` is clamped down to it rather than left to produce
 * an unsafe-integer OFFSET.
 */
function readPage(url: URL, key: string): number {
	const raw = Number.parseInt(url.searchParams.get(key) ?? '', 10);
	if (!Number.isFinite(raw) || raw < 1) return 1;
	return Math.min(raw, MAX_PAGE);
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
			characterCount: sql<number>`(select count(*) from ${characters} where ${characters.userId} = ${sql.raw('"users"."id"')})`
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
		// A full page is not evidence of a next page: with an exact multiple of
		// PAGE_SIZE rows, the last page comes back full and "Next" would lead to
		// an empty one. Both tables list every row their count counts (the
		// characters join cannot drop rows — user_id is NOT NULL with an
		// enforced FK), so the totals are the authority.
		usersHasNext: usersPage * PAGE_SIZE < totalUsers,
		charactersHasNext: charactersPage * PAGE_SIZE < totalCharacters,
		userSort,
		characterSort
	};
};
