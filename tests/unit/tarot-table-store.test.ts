import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createTarotTable, type TableState } from '$lib/stores/tarot-deck';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

const ids = (state: TableState) =>
	[...state.drawPile, ...state.discard, ...state.hand].map((card) => card.id);

describe('tarot table Fool reshuffle', () => {
	it('preserves the visible Fool, both decks, and the following push exactly once', () => {
		const table = createTarotTable(config, 'e2e-8');
		table.drawCards(1);
		expect(get(table).hand.map((card) => card.id)).toEqual(['fool']);
		const oldUnshuffledSuccessor = get(table).drawPile[0].id;

		table.reshuffleForFool();
		const reshuffled = get(table);
		expect(reshuffled.hand.map((card) => card.id)).toEqual(['fool']);
		expect(reshuffled.discard).toEqual([]);
		expect(reshuffled.gmDiscard).toEqual([]);
		expect(reshuffled.foolReshuffled).toBe(true);
		expect(new Set(ids(reshuffled)).size).toBe(57);
		expect(new Set(reshuffled.gmDrawPile.map((card) => card.id)).size).toBe(21);

		table.reshuffleForFool();
		expect(get(table)).toEqual(reshuffled);

		table.drawCards(1);
		const pushed = get(table);
		expect(pushed.hand).toHaveLength(2);
		expect(pushed.hand[1].id).not.toBe(oldUnshuffledSuccessor);
		expect(pushed.foolReshuffled).toBe(true);
		expect(new Set(ids(pushed)).size).toBe(57);

		table.reshuffleForFool();
		expect(get(table)).toEqual(pushed);
	});

	it('clears the result-lifetime marker only when the visible result is cleared', () => {
		const table = createTarotTable(config, 'e2e-8');
		table.drawCards(1);
		table.reshuffleForFool();
		table.discardHand();
		expect(get(table).hand).toEqual([]);
		expect(get(table).foolReshuffled).toBe(false);
	});
});
