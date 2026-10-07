/**
 * Migrate-on-read for stored adventurer JSON. Preserves the player's choices and
 * only fills in fields/defaults required by the current app version. At schema
 * v1 this is essentially a defensive normaliser: it merges stored data over a
 * blank base so every field the app reads is guaranteed to exist, even for
 * partially-written drafts. Future schema bumps add version-stepped transforms
 * here before the final normalise.
 *
 * Pure — no UI or DB imports.
 */

import {
	CHARACTER_SCHEMA_VERSION,
	createBlankCharacter,
	type GuildBookCharacterData,
	type AttributeState,
	type CharacterLife,
	type XpEntry,
	type XpLedger
} from '$lib/types/character';
import { SUIT_IDS } from '$lib/types/common';

export function migrateCharacterData(raw: unknown): GuildBookCharacterData {
	const base = createBlankCharacter();
	if (!raw || typeof raw !== 'object') return base;

	const stored = raw as Partial<GuildBookCharacterData> & Record<string, unknown>;
	const storedVersion = typeof stored.schemaVersion === 'number' ? stored.schemaVersion : 0;
	const legacyExperience = typeof stored.experience === 'number' ? stored.experience : 0;

	// Merge each suit's attribute state over the base so all four suits exist.
	const attributes = { ...base.attributes };
	if (stored.attributes && typeof stored.attributes === 'object') {
		for (const suit of SUIT_IDS) {
			const s = (stored.attributes as Record<string, AttributeState>)[suit];
			if (s && typeof s === 'object') {
				attributes[suit] = {
					value: typeof s.value === 'number' ? s.value : 0,
					sources: Array.isArray(s.sources) ? s.sources : []
				};
			}
		}
	}

	return {
		...base,
		...stored,
		system: 'hmtw',
		schemaVersion: CHARACTER_SCHEMA_VERSION,
		attributes,
		resolve: { ...base.resolve, ...(stored.resolve ?? {}) },
		arete: {
			triggersMet: normalizeTriggers(stored.arete?.triggersMet),
			talentEarned: stored.arete?.talentEarned ?? base.arete.talentEarned
		},
		// v1 → v2: talents gain wounded/xp, bonds gain charged, equipment gains
		// location/quantity/notchesTaken, afflictions appear. Defaults preserve
		// every stored choice; unplaced gear defaults to the pack (the caller can
		// re-run auto-placement — see engine/encumbrance.ts).
		talents: (Array.isArray(stored.talents) ? stored.talents : base.talents).map((t) => ({
			...t,
			wounded: typeof t.wounded === 'boolean' ? t.wounded : false,
			xp: typeof t.xp === 'number' ? t.xp : 0,
			preparedUses: storedVersion < 4 ? null : (typeof t.preparedUses === 'number' || t.preparedUses === null ? t.preparedUses : null)
		})),
		experience: legacyExperience,
		xpLedger: storedVersion < 4
			? { openingBalance: legacyExperience, entries: [] }
			: normalizeXpLedger(stored.xpLedger, legacyExperience),
		motifs: Array.isArray(stored.motifs) ? stored.motifs : base.motifs,
		bonds: (Array.isArray(stored.bonds) ? stored.bonds : base.bonds).map((b) => ({
			...b,
			charged: typeof b.charged === 'boolean' ? b.charged : false
		})),
		equipment: (Array.isArray(stored.equipment) ? stored.equipment : base.equipment).map((e) => ({
			...e,
			location: ['hand', 'belt', 'pack', 'worn'].includes(e.location) ? e.location : 'pack',
			quantity: typeof e.quantity === 'number' && e.quantity > 0 ? e.quantity : 1,
			notchesTaken: typeof e.notchesTaken === 'number' ? e.notchesTaken : 0
		})),
		afflictions: Array.isArray(stored.afflictions) ? stored.afflictions : [],
		// v2 → v3: life state becomes explicit. Reject incomplete death records
		// rather than retaining partial audit metadata.
		life: normalizeLife(stored.life),
		languages: Array.isArray(stored.languages) ? stored.languages : base.languages,
		conditions: Array.isArray(stored.conditions) ? stored.conditions : base.conditions,
		lore: typeof stored.lore === 'number' ? stored.lore : base.lore
	};
}

/**
 * Unlike every sibling field here, a v5+ document's xpLedger was passed
 * through untouched (`stored.xpLedger ?? default`) — a present-but-malformed
 * value (not `null`/`undefined`) skipped every check and reached downstream
 * `.reduce`/`.some` calls unvalidated. Genuinely missing stays the same
 * fallback; a garbled shape now falls back the same way instead of crashing,
 * and each entry is checked structurally rather than trusted wholesale.
 */
function normalizeXpLedger(value: unknown, fallbackBalance: number): XpLedger {
	if (!value || typeof value !== 'object') return { openingBalance: fallbackBalance, entries: [] };
	const ledger = value as Record<string, unknown>;
	const openingBalance = typeof ledger.openingBalance === 'number' ? ledger.openingBalance : fallbackBalance;
	const entries = Array.isArray(ledger.entries) ? ledger.entries.filter(isPlausibleXpEntry) : [];
	return { openingBalance, entries };
}

function isPlausibleXpEntry(value: unknown): value is XpEntry {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === 'string' &&
		typeof entry.at === 'string' &&
		typeof entry.delta === 'number' &&
		typeof entry.kind === 'string' &&
		typeof entry.sourceId === 'string' &&
		typeof entry.sourceLabel === 'string' &&
		typeof entry.reason === 'string'
	);
}

function normalizeLife(value: unknown): CharacterLife {
	if (!value || typeof value !== 'object') return { status: 'alive' };

	const life = value as Record<string, unknown>;
	if (life.status !== 'dead') return { status: 'alive' };
	if (!isNonEmptyString(life.diedAt) || !isNonEmptyString(life.markedByUserId)) {
		return { status: 'alive' };
	}
	if (life.campaignId !== undefined && !isNonEmptyString(life.campaignId)) {
		return { status: 'alive' };
	}
	if (life.sessionId !== undefined && !isNonEmptyString(life.sessionId)) {
		return { status: 'alive' };
	}

	return {
		status: 'dead',
		diedAt: life.diedAt,
		...(life.campaignId === undefined ? {} : { campaignId: life.campaignId }),
		...(life.sessionId === undefined ? {} : { sessionId: life.sessionId }),
		markedByUserId: life.markedByUserId
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function normalizeTriggers(value: unknown): [boolean, boolean, boolean] {
	if (Array.isArray(value) && value.length === 3) {
		return [Boolean(value[0]), Boolean(value[1]), Boolean(value[2])];
	}
	return [false, false, false];
}
