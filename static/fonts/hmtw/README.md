# HMTW export fonts

The type stack used by the denizen stat-block PDF export
(`src/lib/export/denizen-pdf-export.ts`), matching the book's look:

| File | Face | Use | Licence |
| --- | --- | --- | --- |
| `IMFellEnglish-Regular.ttf` / `-Italic.ttf` | IM Fell English (Igino Marini) | Body text, 10.5pt | SIL OFL (Google Fonts) |
| `HamletOrNot.ttf` | Hamlet or Not | Creature names 24pt, pool titles 18pt | Free (dafont) |
| `CaslonAntique-Bold.ttf` | Caslon Antique Bold | Section headers & stat labels 16pt; also fills IM Fell's missing bold slot | Free |

IM Fell English has no bold cut, so bold runs (ability names) intentionally
render in Caslon Antique Bold.

Fonts are fetched at export time in the browser and embedded in the generated
PDF; they are not used for the web UI itself.
