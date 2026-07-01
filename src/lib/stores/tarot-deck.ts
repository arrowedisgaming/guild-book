/**
 * Virtual tarot table — client-side deck state (draw pile, discard, hand) built
 * from a content-pack TarotConfig. Wraps the pure engine (drawWithReshuffle) so
 * the draw pile auto-reshuffles the discard when it empties. A factory, since
 * each /deck page instance owns its own table.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import {
	buildPlayerDeck,
	shuffleDeck,
	drawWithReshuffle,
	type TarotCard
} from '$lib/engine/tarot-deck';
import { makeRng, type Rng } from '$lib/engine/rng';
import type { TarotConfig } from '$lib/types/content-pack';

export interface TableState {
	drawPile: TarotCard[];
	discard: TarotCard[];
	hand: TarotCard[];
	/** Transient flag: the last draw triggered an auto-reshuffle (for a cue). */
	reshuffled: boolean;
}

export function createTarotTable(config: TarotConfig) {
	const full = buildPlayerDeck(config);
	// Random seed on the client; deterministic on the server so SSR and hydration
	// agree (only the face-down count is rendered, never the order).
	let rng: Rng = makeRng(browser ? `${Math.random()}` : 'ssr');

	function fresh(): TableState {
		return {
			drawPile: browser ? shuffleDeck(full, rng) : full.slice(),
			discard: [],
			hand: [],
			reshuffled: false
		};
	}

	const { subscribe, update, set } = writable<TableState>(fresh());

	return {
		subscribe,

		/** Draw `count` cards into the hand, auto-reshuffling if needed. */
		drawCards(count = 1) {
			update((s) => {
				const res = drawWithReshuffle(s.drawPile, s.discard, count, rng);
				return {
					drawPile: res.drawPile,
					discard: res.discard,
					hand: [...s.hand, ...res.drawn],
					reshuffled: res.reshuffled
				};
			});
		},

		/** Clear the transient reshuffle cue flag. */
		clearReshuffleFlag() {
			update((s) => (s.reshuffled ? { ...s, reshuffled: false } : s));
		},

		/** Move the current hand to the discard pile. */
		discardHand() {
			update((s) => ({
				...s,
				discard: [...s.discard, ...s.hand],
				hand: [],
				reshuffled: false
			}));
		},

		/** Deliberately reshuffle everything back into a full draw pile. */
		reshuffleAll() {
			update((s) => ({
				drawPile: shuffleDeck([...s.drawPile, ...s.discard, ...s.hand], rng),
				discard: [],
				hand: [],
				reshuffled: true
			}));
		},

		/** Start over with a freshly-seeded, freshly-shuffled deck. */
		reset() {
			rng = makeRng(browser ? `${Math.random()}` : 'ssr');
			set(fresh());
		}
	};
}

// --- Animation preference (persisted) --------------------------------------

const ANIM_KEY = 'guildbook-tarot-animate';

function loadAnimate(): boolean {
	if (!browser) return true;
	return localStorage.getItem(ANIM_KEY) !== 'off';
}

export const tarotAnimate = writable<boolean>(loadAnimate());

if (browser) {
	tarotAnimate.subscribe((on) => localStorage.setItem(ANIM_KEY, on ? 'on' : 'off'));
}
