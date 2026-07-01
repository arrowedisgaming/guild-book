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
