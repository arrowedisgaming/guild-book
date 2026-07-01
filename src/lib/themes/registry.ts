/** Available themes. `id` matches the `[data-theme]` attribute on <html>. */
export const THEMES = [
	{ id: 'parchment-light', label: 'Parchment' },
	{ id: 'worm-dark', label: 'Worm' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'parchment-light';

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === 'string' && THEMES.some((t) => t.id === value);
}
