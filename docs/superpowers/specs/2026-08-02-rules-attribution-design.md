# Rules attribution card — design

**Date:** 2026-08-02
**Status:** Approved

## Problem

The rules reference reproduces the full text of *His Majesty the Worm* chapters
1–9. That is only possible because Josh McCrowell published the game under an
unusually permissive open license and then gave direct permission for the full
chapter text. Today the only acknowledgement of that is the site-wide footer
disclaimer and the `/licensing` page — both of which read as legal boilerplate,
not thanks, and neither of which tells a reader where to buy the book.

A reader who arrives at a rules page from a search engine can read an entire
chapter without ever learning the book exists as a purchasable object.

## Goals

- Thank Josh McCrowell, by name, on every rules page.
- Give every rules page a direct route to buying the book.
- Read as gratitude, not as advertising.

## Non-goals

- Changing the license-required disclaimer. See "License compliance" below.
- Extending the card to `/denizens`, the character wizard, or the sheet.
  Those also surface book text, but the owner scoped this change to the rules
  pages. Revisit separately if wanted.
- Any change to game data. This is site chrome; nothing goes in the content
  pack.

## Design

### Component

A new presentational component, `src/lib/components/rules/RulebookThanks.svelte`.
No props — the copy is fixed, and parameterising it would invite per-page
variants nobody asked for. It wraps its content in the existing
`$lib/components/decoration/OrnamentalBorder.svelte`, matching the treatment
already used for the notice on `/licensing`.

### Placement

Rendered as the last element of the page `<section>` on both:

- `src/routes/rules/+page.svelte` (the index and search page)
- `src/routes/rules/[section]/+page.svelte` (a chapter)

On the index page it must sit **outside** the `{#if query.trim() && hits}`
block that switches between search results and the chapter TOC. All three
states — TOC, results, and "No rules match" — are rules pages, and the card is
meant to be ever-present.

A footer position was chosen over a top banner deliberately: the card reads as
a colophon, which suits gratitude, and it never sits between the reader and the
search box they came for.

### Copy

Verbatim, as approved:

> **With thanks to Josh McCrowell**
>
> **His Majesty the Worm** is his work. It is shown here only because he
> [licensed the game](https://www.hismajestytheworm.games/open-license)
> generously enough for people like us to build from it.
>
> A searchable reference is no substitute for the book itself. It's a beautiful
> object, and buying it is the best way to support Josh and the game.
>
> Learn more & Purchase
> [His Majesty the Worm](https://www.hismajestytheworm.games/his-majesty-the-worm)

Two links, both to `hismajestytheworm.games`, both `target="_blank"
rel="noopener"`:

| Link text | Href |
| --- | --- |
| licensed the game | `https://www.hismajestytheworm.games/open-license` |
| His Majesty the Worm | `https://www.hismajestytheworm.games/his-majesty-the-worm` |

The book title in the first paragraph is `<strong>`. The title is set "His
Majesty the Worm" — lowercase *the* — matching how it is set everywhere else on
the site and in the license text itself.

### Styling

- Centred text, constrained to the `46rem` rules column so it aligns with the
  chapter body above it.
- Heading in `--font-subhead`; body in `--ink-soft`.
- The purchase link rendered with more visual weight than the license link —
  it is the call to action — using `--accent`.
- Generous top margin so the card reads as separate from the last rule article
  rather than as a continuation of it.
- Must wrap rather than overflow at 320 CSS pixels and at 200% zoom. This is a
  standing hard constraint in this layout; see the comments on `.site-nav` in
  `src/routes/+layout.svelte` and on `.alpha-banner` in `AlphaBanner.svelte`
  for why.

## License compliance

The "Adherent of the Worm" license requires this exact statement, with the
bracketed slots filled:

> His Majesty the Worm is copyright Joshua McCrowell. [product name] is an
> independent production by [publisher name] and is not affiliated with Joshua
> McCrowell or Exalted Funeral.

It must appear "in the legal text and on any websites where commercial products
are sold."

Guild Book currently carries it, correctly filled in, in five places:

- `src/routes/+layout.svelte` — the site-wide footer
- `src/routes/licensing/+page.svelte` — the framed notice
- `src/lib/export/markdown-export.ts`
- `src/lib/export/pdf-export.ts`
- `src/lib/export/denizen-pdf-export.ts`

**None of these change.** An earlier draft of this work replaced the footer
sentence with warmer wording; that was dropped once the license requirement was
confirmed. The new card is additive — it sits alongside the required statement,
never in place of it.

## Spelling: licence → license

Josh's own page is titled "Open License" and uses the American spelling
throughout. The project has been using British "licence" in prose. Align to
his.

In scope:

- `src/routes/licensing/+page.svelte` (3 occurrences)
- `src/lib/types/content-pack.ts` (1, in a comment)
- `README.md`, `CONTRIBUTING.md`, `DEPLOY.md`
- `package.json` — the `description` field
- `static/content-packs/hmtw/README.md`
- `static/content-packs/hmtw/index.json` — the `description` field

Out of scope, deliberately: historical `CHANGELOG.md` entries and dated files
under `docs/superpowers/`. Those are records of what was written at the time;
rewriting them adds churn and obscures history.

Note that `licensing`, `licensed`, and the `/licensing` route are spelled the
same either way and need no change. The GPL-3.0 reference on `/licensing` is a
proper noun ("GNU General Public License") and is already correct.

## Testing

E2E, in a new `tests/e2e/rules-attribution.spec.ts`:

1. The card is visible on `/rules`.
2. The card is visible on a `/rules/[section]` page.
3. The license link's `href` is exactly
   `https://www.hismajestytheworm.games/open-license`.
4. The purchase link's `href` is exactly
   `https://www.hismajestytheworm.games/his-majesty-the-worm`.

Assertions 3 and 4 are the ones that matter. Copy drift is cosmetic; a broken
purchase link is the only failure mode with a real cost, and it is the kind of
thing a careless find-and-replace breaks silently.

No unit tests — the component has no logic. The existing export tests, which
assert `'not affiliated'` and `'copyright Joshua McCrowell'`, must stay green;
they will, because no export file is touched.

## Changelog

Under `[Unreleased]`:

- `### Added` — the rules attribution card.
- `### Changed` — the license spelling alignment.
