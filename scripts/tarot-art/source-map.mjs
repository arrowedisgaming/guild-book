/**
 * The explicit 80-file source map for the tarot artwork pipeline (issue #10,
 * Task 1): every stable card ID from the content pack mapped to exactly one
 * source scan, plus the two named backs.
 *
 * Amendment 3: everything collection-specific — the id, the source and output
 * paths, and the filename prefix — reads from the single `COLLECTION`
 * constant below, so an equivalent public-domain source set stays a cheap
 * swap rather than a rewrite.
 */

export const COLLECTION = Object.freeze({
	id: 'rwsa',
	title: 'Rider–Waite–Smith tarot',
	sourceDir: 'assets-src/tarot/rwsa',
	outputDir: 'static/tarot/rwsa',
	/** Public URL prefix the emitted variant paths live under. */
	publicPathPrefix: '/tarot/rwsa',
	filePrefix: 'RWSa-'
});

const file = (/** @type {string} */ code) => `${COLLECTION.filePrefix}${code}.png`;

/**
 * The 22 majors, explicit rather than derived, so a name/number ordering
 * mistake is reviewable line by line. The scans use RWS numbering: Strength
 * is VIII (T-08) and Justice is XI (T-11), which matches the content pack's
 * `majorArcana` numbers.
 */
export const MAJOR_SOURCE_MAP = Object.freeze({
	fool: file('T-00'),
	magician: file('T-01'),
	'high-priestess': file('T-02'),
	empress: file('T-03'),
	emperor: file('T-04'),
	hierophant: file('T-05'),
	lovers: file('T-06'),
	chariot: file('T-07'),
	strength: file('T-08'),
	hermit: file('T-09'),
	'wheel-of-fortune': file('T-10'),
	justice: file('T-11'),
	'hanged-man': file('T-12'),
	death: file('T-13'),
	temperance: file('T-14'),
	devil: file('T-15'),
	tower: file('T-16'),
	star: file('T-17'),
	moon: file('T-18'),
	sun: file('T-19'),
	judgement: file('T-20'),
	world: file('T-21')
});

/** Source filename codes per rank id ('0A' is the ace). */
export const RANK_SOURCE_SUFFIX = Object.freeze({
	i: '0A',
	ii: '02',
	iii: '03',
	iv: '04',
	v: '05',
	vi: '06',
	vii: '07',
	viii: '08',
	ix: '09',
	x: '10',
	page: 'J1',
	knight: 'J2',
	queen: 'QU',
	king: 'KI'
});

export const SUIT_SOURCE_PREFIX = Object.freeze({
	swords: 'S',
	pentacles: 'P',
	cups: 'C',
	wands: 'W'
});

/**
 * The card backs are NOT the RWSa scans: per the maintainer's decision on
 * issue #10, both scanned backs are scrapped and the deck uses the
 * "Adherent of His Majesty the Worm" third-party logo, composed onto a flat
 * field at build time — one treatment per app theme. The logo is committed
 * (`adherent-logo.png`, from the official third-party template, whose terms
 * state: "You are allowed and encouraged (but not required) to use the
 * 'Adherent of the Worm' logo"); the composition below is the entire
 * recipe, so the backs are reproducible code, not hand-made binaries.
 *
 * `ink: null` means the logo's own black linework is used as-is; an rgb ink
 * recolors the linework via its alpha channel.
 */
export const BACK_LOGO_FILE = 'adherent-logo.png';
export const BACK_COMPOSITIONS = Object.freeze({
	/** Rendered by the parchment-light theme. */
	'adherent-parchment': Object.freeze({
		field: Object.freeze({ r: 236, g: 225, b: 203 }),
		ink: null
	}),
	/** Rendered by the worm-dark theme. */
	'adherent-dark': Object.freeze({
		field: Object.freeze({ r: 33, g: 29, b: 24 }),
		ink: Object.freeze({ r: 240, g: 232, b: 214 })
	})
});

/**
 * Downloaded by `fetch-rwsa-tarot.sh` but deliberately unmapped: the two
 * RWSa scanned backs the issue #10 decision replaced. Listed so the strict
 * inventory can stay exact — the source directory must contain the 78
 * mapped faces plus exactly these, and nothing else.
 */
export const KNOWN_UNUSED_SOURCES = Object.freeze([file('X-BA'), file('X-RL')]);

function buildMinorSourceMap() {
	/** @type {Record<string, string>} */
	const entries = {};
	for (const [suit, suitCode] of Object.entries(SUIT_SOURCE_PREFIX)) {
		for (const [rank, rankCode] of Object.entries(RANK_SOURCE_SUFFIX)) {
			entries[`${suit}-${rank}`] = file(`${suitCode}-${rankCode}`);
		}
	}
	return entries;
}

/** All 78 faces: 56 minors (`<suit>-<rank>`) + the Fool + 21 majors. */
export const FACE_SOURCE_MAP = Object.freeze({
	...buildMinorSourceMap(),
	...MAJOR_SOURCE_MAP
});
