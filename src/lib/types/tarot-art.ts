/** Resolved responsive image sources for one tarot card face or back
 * (issue #10 Task 3). Width/height are the source scan's intrinsic
 * dimensions — callers use them for aspect-ratio layout, never for crop. */
export interface TarotImageSources {
	avifSrcset: string;
	webpSrcset: string;
	/** Plain `<img src>` fallback: the 480-wide WebP — the size a card most
	 * commonly renders at; browsers that understand `srcset` never load it. */
	fallbackWebp: string;
	width: number;
	height: number;
}

/** The two themed treatments of the Adherent back (issue #10 decision):
 * `TarotCard` renders both and the active app theme selects one via CSS. */
export type TarotBackId = 'adherent-parchment' | 'adherent-dark';
