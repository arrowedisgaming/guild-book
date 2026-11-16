/**
 * Where the global `/` shortcut sends focus. SiteSearch owns the shortcut and
 * focuses the header search unless a page-level search (the rules side panel
 * beside the sheet) has registered itself here while it is mounted.
 */
export const slashTarget = $state<{ focus: (() => void) | null }>({ focus: null });
