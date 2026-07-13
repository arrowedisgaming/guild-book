<script lang="ts">
	import CardTable from '$lib/components/decoration/CardTable.svelte';
	import OrnamentalBorder from '$lib/components/decoration/OrnamentalBorder.svelte';

	const fontRows: (string | number)[][] = [
		['IM Fell English', 'Body & quotes', 'SIL Open Font License (OFL)'],
		['Bilbo Display', 'Display / H1', 'Freeware — verify webfont terms'],
		['HamletOrNot', 'Headings', 'Freeware — verify webfont terms'],
		['Caslon Antique', 'Subheadings', 'Freeware — verify webfont terms'],
		['Dark Roast', 'Pull-quotes', 'Freeware — verify webfont terms'],
		['Kelmscott', 'Sidebar headings', 'Freeware — verify webfont terms'],
		['Goudy Old Style', 'Sidebar body', '⚠ Monotype — commercial webfont licence required']
	];
</script>

<svelte:head><title>Licensing &amp; Credits — Guild Book</title></svelte:head>

<section class="licensing">
	<h1>Licensing &amp; Credits</h1>

	<img class="logo" src="/brand/adherent-of-the-worm.png" alt="Adherent of His Majesty the Worm" />

	<OrnamentalBorder>
		<p class="notice">
			His Majesty the Worm is copyright Joshua McCrowell. Guild Book is an independent production by
			Arrowed and is not affiliated with Joshua McCrowell or Exalted Funeral.
		</p>
	</OrnamentalBorder>

	<h2>What this means</h2>
	<ul>
		<li>
			Guild Book is an unofficial, fan-made companion, published under the
			<a href="https://www.hismajestytheworm.games/open-license" rel="noopener" target="_blank">
				“Adherent of the Worm” open licence</a
			>, which permits reuse of the game's mechanics and text.
		</li>
		<li>
			It uses the permitted <em>Adherent of the Worm</em> logo. It does <strong>not</strong> use
			the official His Majesty the Worm logo, artwork, or trade dress.
		</li>
		<li>
			Game text — talent, condition, affliction, kith, path, language, and equipment descriptions —
			is reproduced verbatim from the core rulebook, per the licence's own terms: “the mechanics and
			game text of His Majesty the Worm may be reused freely.” No book artwork, logos, or trade dress
			are reproduced.
		</li>
		<li>This is not an official product and is not endorsed by or affiliated with the publisher.</li>
	</ul>

	<h2>Application source</h2>
	<p>
		The Guild Book application code is released under the
		<a href="https://www.gnu.org/licenses/gpl-3.0.html" rel="noopener" target="_blank">
			GNU General Public License v3.0</a
		>. Source: <a href="https://github.com/arrowedisgaming/guild-book" rel="noopener" target="_blank">github.com/arrowedisgaming/guild-book</a>.
	</p>

	<h2>Typography</h2>
	<p class="muted">
		The book's typefaces are used to match its style. Licence status is tracked below — faces marked
		for verification must be cleared for web embedding before a public launch.
	</p>
	<CardTable columns={['Typeface', 'Role', 'Licence']} rows={fontRows} />
</section>

<style>
	.licensing {
		max-width: 44rem;
		margin: 0 auto;
	}
	.logo {
		display: block;
		width: 200px;
		max-width: 60%;
		margin: 1rem 0 1.5rem;
	}
	:global([data-theme='worm-dark']) .logo {
		filter: invert(0.92) hue-rotate(180deg);
	}
	.notice {
		margin: 0;
		font-family: var(--font-subhead);
		font-size: 1.05rem;
		text-align: center;
	}
	h2 {
		margin-top: 1.75rem;
	}
	ul {
		padding-left: 1.2rem;
	}
	li {
		margin: 0.4rem 0;
	}
	.muted {
		color: var(--ink-soft);
	}
</style>
