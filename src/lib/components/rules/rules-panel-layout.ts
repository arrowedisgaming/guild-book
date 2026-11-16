/**
 * Viewport width from which the owner's sheet shows the rules panel beside it.
 *
 * The smallest width at which the sheet column keeps its full 48rem next to
 * the minimum 22rem panel. Content rem is 18px (base.css sets html to 18px),
 * but media-query rem is the browser default (16px), so in px:
 *   48rem + 2rem gap + 22rem panel + 2 × 1.25rem site padding
 *   = 864 + 36 + 396 + 45 = 1341px  →  84rem (1344px) as a media query.
 *
 * CSS cannot import this, so the same `84rem` appears in the `.site.wide` rule
 * in src/routes/+layout.svelte and the grid rule in src/routes/sheet/[id]/+page.svelte.
 * Change all three together.
 */
export const RULES_PANEL_MEDIA_QUERY = 'min-width: 84rem';
