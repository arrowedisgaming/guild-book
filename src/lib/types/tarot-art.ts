/** Resolved responsive image sources for one tarot card face or back
 * (issue #10 Task 3). Width/height are the source scan's intrinsic
 * dimensions — callers use them for aspect-ratio layout, never for crop. */
export interface TarotImageSources {
	avifSrcset: string;
	webpSrcset: string;
	/** Plain `<img src>` fallback: the 480-wide WebP — the size a card most
	 * commonly renders at — or the pinned tier's WebP when one was requested,
	 * so a browser without `srcset` support does not silently drop below the
	 * tier its caller required. Browsers that understand `srcset` never load
	 * it either way. */
	fallbackWebp: string;
	width: number;
	height: number;
}

/** The three emitted widths (issue #10 Task 2). Naming a tier pins which
 * derivative a caller gets instead of leaving it to `sizes` negotiation —
 * what the enlargement dialog's 960 requirement needs. */
export type TarotArtTier = 240 | 480 | 960;

/** The two themed treatments of the Adherent back (issue #10 decision):
 * `TarotCard` renders both and the active app theme selects one via CSS. */
export type TarotBackId = 'adherent-parchment' | 'adherent-dark';
