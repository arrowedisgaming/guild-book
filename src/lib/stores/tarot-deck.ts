/**
 * Virtual tarot table — client-side deck state (draw pile, discard, hand) built
 * from a content-pack TarotConfig. Wraps the pure engine (drawWithReshuffle) so
 * the draw pile auto-reshuffles the discard when it empties. A factory, since
 * each /deck page instance owns its own table.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import {
	buildMajorDeck,
	buildPlayerDeck,
	shuffleDeck,
	drawWithReshuffle,
	reshuffleAfterFool,
	type MajorCard,
	type TarotCard
} from '$lib/engine/tarot-deck';
import { makeRng, type Rng } from '$lib/engine/rng';
import type { TarotConfig } from '$lib/types/content-pack';

export interface TableState {
	drawPile: TarotCard[];
	discard: TarotCard[];
	hand: TarotCard[];
	gmDrawPile: MajorCard[];
	gmDiscard: MajorCard[];
	/** Transient flag: the last draw triggered an auto-reshuffle (for a cue). */
	reshuffled: boolean;
	/** True once both decks were reshuffled for the Fool in the visible result. */
	foolReshuffled: boolean;
}

/**
 * @param seed pins the shuffle so a run is reproducible — used by `/deck?seed=`
 *   and by E2E, which cannot assert an outcome against a random deck. Omitted,
 *   the client seeds randomly.
 */
export function createTarotTable(config: TarotConfig, seed?: string) {
	const full = buildPlayerDeck(config);
	const fullMajor = buildMajorDeck(config);
	// Random seed on the client unless one is pinned; deterministic on the server
	// so SSR and hydration agree (only the face-down count is rendered, never the
	// order).
	let runtimeSeed = seed ?? (browser ? `${Math.random()}` : 'ssr');
	let rng: Rng = makeRng(runtimeSeed);
	let gmRng: Rng = makeRng(`${runtimeSeed}:major`);

	function fresh(): TableState {
		return {
			// A pinned seed must shuffle on the server too, or a seeded SSR render
			// would show an unshuffled deck and then change on hydration.
			drawPile: browser || seed ? shuffleDeck(full, rng) : full.slice(),
			discard: [],
			hand: [],
			gmDrawPile: shuffleDeck(fullMajor, gmRng),
			gmDiscard: [],
			reshuffled: false,
			foolReshuffled: false
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
					...s,
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

		/** Reshuffle both remaining decks once while a visible Fool stays held. */
		reshuffleForFool() {
			update((state) => {
				if (state.foolReshuffled || !state.hand.some((card) => card.id === 'fool')) return state;
				const next = reshuffleAfterFool(
					{ drawPile: state.drawPile, discard: state.discard, held: state.hand },
					{ drawPile: state.gmDrawPile, discard: state.gmDiscard, held: [] },
					rng,
					gmRng
				);
				return {
					...state,
					drawPile: next.player.drawPile,
					discard: next.player.discard,
					hand: next.player.held,
					gmDrawPile: next.major.drawPile,
					gmDiscard: next.major.discard,
					foolReshuffled: true
				};
			});
		},

		/** Move the current hand to the discard pile. */
		discardHand() {
			update((s) => ({
				...s,
				discard: [...s.discard, ...s.hand],
				hand: [],
				reshuffled: false,
				foolReshuffled: false
			}));
		},

		/** Deliberately reshuffle everything back into a full draw pile. */
		reshuffleAll() {
			update((s) => ({
				drawPile: shuffleDeck([...s.drawPile, ...s.discard, ...s.hand], rng),
				discard: [],
				hand: [],
				gmDrawPile: shuffleDeck([...s.gmDrawPile, ...s.gmDiscard], gmRng),
				gmDiscard: [],
				reshuffled: true,
				foolReshuffled: false
			}));
		},

		/** Start over with a freshly-seeded, freshly-shuffled deck. */
		reset() {
			runtimeSeed = browser ? `${Math.random()}` : 'ssr';
			rng = makeRng(runtimeSeed);
			gmRng = makeRng(`${runtimeSeed}:major`);
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
