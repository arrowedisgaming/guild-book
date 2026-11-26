import { writable } from 'svelte/store';
import { browser } from '$app/environment';

/** Whether the sheet's tarot marginalia are drawn. On unless switched off. */
export const FLOURISHES_KEY = 'guildbook-flourishes';

function load(): boolean {
	if (!browser) return true;
	try {
		return localStorage.getItem(FLOURISHES_KEY) !== 'off';
	} catch {
		return true;
	}
}

export const flourishes = writable<boolean>(load());

if (browser) {
	flourishes.subscribe((on) => {
		try {
			localStorage.setItem(FLOURISHES_KEY, on ? 'on' : 'off');
		} catch {
			// Private windows can refuse storage; the choice then lasts for the visit.
		}
	});
}
