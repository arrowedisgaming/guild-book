import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '$lib/themes/registry';

export const THEME_KEY = 'guildbook-theme';

function load(): ThemeId {
	if (!browser) return DEFAULT_THEME;
	const stored = localStorage.getItem(THEME_KEY);
	return isThemeId(stored) ? stored : DEFAULT_THEME;
}

export const theme = writable<ThemeId>(load());

if (browser) {
	theme.subscribe((t) => {
		localStorage.setItem(THEME_KEY, t);
		document.documentElement.setAttribute('data-theme', t);
	});
}
