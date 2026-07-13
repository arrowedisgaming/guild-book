# Self-hosted fonts — licence status

These faces come from the His Majesty the Worm "Adherent of the Worm" template
and are used to match the book's typography. Status below is a good-faith
summary — **verify each face's web-embedding terms before a public launch**, and
in particular resolve Goudy Old Style.

| File | Face | Role | Licence status |
| --- | --- | --- | --- |
| `imfell-english.woff2` / `-italic` | IM Fell English | Body, quotes fallback | **OFL** (SIL Open Font License) — clear to self-host |
| `bilbo-display.woff2` | Bilbo Display | H1 / display | Freeware — verify webfont terms |
| `hamletornot.woff2` | HamletOrNot | H2 / H3 headings | Freeware — verify webfont terms |
| `caslon-antique.woff2` | Caslon Antique | H4 / subheads | Freeware — verify webfont terms |
| `dark-roast.woff2` | Dark Roast | Pull-quotes | Freeware — verify webfont terms |
| `kelmscott.woff2` | Kelmscott | Sidebar headings | Freeware — verify webfont terms |
| `goudy-old-style.woff2` | Goudy Old Style | Sidebar body | ⚠️ **Monotype commercial** — a webfont licence is required before public deployment, or substitute an OFL Goudy (e.g. Sorts Mill Goudy) |

If any face cannot be licensed for web embedding, drop it from
`src/lib/themes/fonts.css` and point that role's `--font-*` token in
`src/lib/themes/base.css` at an OFL fallback — a one-line change.

## PDF-export faces (`hmtw/`, TTF)

These are **embedded into generated PDFs** (the denizen stat-block export,
`src/lib/export/denizen-pdf-export.ts`), not served as webfonts. They are
fetched in the browser at export time. Three of them are TTF cuts of faces the
webfont table above already tracks; the licence questions are the same, plus
PDF-embedding rights specifically.

All four files are byte-identical (verified by SHA-256) to the copies shipped in
the official Creator's Kit ("Adherent of the Worm Template", `Document fonts/`
folder), renamed for URL-friendliness:

| File | Face | Kit filename | Licence status |
| --- | --- | --- | --- |
| `hmtw/IMFellEnglish-Regular.ttf` | IM Fell English (Igino Marini) | `IM_FELL_ENGLISH_ROMAN.TTF` | **OFL** — clear to embed |
| `hmtw/IMFellEnglish-Italic.ttf` | IM Fell English Italic | `IM_FELL_ENGLISH_ITALIC.TTF` | **OFL** — clear to embed |
| `hmtw/HamletOrNot.ttf` | Hamlet or Not | `HamletOrNot.ttf` | Freeware, supplied by the kit — verify PDF-embedding terms |
| `hmtw/CaslonAntique-Bold.ttf` | Caslon Antique Bold | `Caslon Antique Bold.ttf` | Freeware, supplied by the kit — verify PDF-embedding terms |

The kit ships no separate licence/notice files for these four faces (its only
bundled licence texts cover faces we don't embed), so there is nothing further
to vendor alongside them.

IM Fell English has no bold cut, so the PDF's bold slot (ability names)
intentionally maps to Caslon Antique Bold.
