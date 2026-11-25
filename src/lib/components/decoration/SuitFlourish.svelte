<script lang="ts">
	/**
	 * A suit emblem drawn as an ink sketch, after the four Aces of the 1909
	 * Rider–Waite–Smith deck: the budding club, the chalice, the crowned sword
	 * and the double-rimmed pentacle. These are original drawings of that
	 * public-domain iconography. They are NOT derived from the card scans in
	 * static/tarot, which stay uncropped and unfiltered (issue #10).
	 *
	 * Purely decorative: aria-hidden, no pointer events. `scene` adds the
	 * moving details and the cloud the emblem rises from; without it the emblem
	 * stands alone, for small sizes.
	 */
	type Suit = 'wands' | 'cups' | 'swords' | 'pentacles';
	let { suit, scene = false }: { suit: Suit; scene?: boolean } = $props();
	const uid = $props.id();
</script>

<svg class="flourish {suit}" class:scene viewBox="0 0 64 100" aria-hidden="true" focusable="false">
	<defs>
		<!-- Three slightly different wobbles; stepping between them is the
		     "boiling line" of hand-drawn animation. -->
		{#each [3, 11, 23] as seed, i (seed)}
			<filter id="{uid}-ink{i}" x="-10%" y="-10%" width="120%" height="120%">
				<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" {seed} result="n" />
				<feDisplacementMap in="SourceGraphic" in2="n" scale="2.1" />
			</filter>
		{/each}
	</defs>
	<g class="ink" style:--ink0="url(#{uid}-ink0)" style:--ink1="url(#{uid}-ink1)" style:--ink2="url(#{uid}-ink2)">
		{#if suit === 'wands'}
			<g class="sway">
				<!-- A rough club, thicker at the head, putting out leaves. -->
				<path class="paper" d="M28 93C28 70 26 48 27 30C27 22 25 16 27 11C29 5 37 4 39 10C41 15 38 21 38 28C38 48 37 70 36 93Z" />
				<path d="M31 13C33 11 36 13 34 16M30 40L32 44M34 56L32 61M31 74L33 78" class="hair" />
				<path d="M38 34C42 32 45 29 47 25M27 46C23 44 20 42 18 38M30 8C28 5 27 3 26 1" />
				<g class="leaf l1"><path class="paper" d="M47 25C48 19 54 17 57 19C56 25 51 27 47 25Z" /><path class="hair" d="M47 25L54 21" /></g>
				<g class="leaf l2"><path class="paper" d="M44 30C47 27 52 29 53 33C49 35 45 34 44 30Z" /><path class="hair" d="M44 30L50 32" /></g>
				<g class="leaf l3"><path class="paper" d="M18 38C12 38 9 33 10 29C16 29 19 33 18 38Z" /><path class="hair" d="M18 38L13 32" /></g>
				<g class="leaf l3"><path class="paper" d="M22 44C17 46 13 44 12 41C16 39 20 40 22 44Z" /><path class="hair" d="M22 44L15 42" /></g>
				<g class="leaf l4"><path class="paper" d="M26 1C21 2 18 -1 18 -5C23 -5 26 -3 26 1Z" /><path class="hair" d="M26 1L21 -3" /></g>
			</g>
			{#if scene}
				<path class="fall f1 paper" d="M50 44C52 40 56 41 56 45C54 48 51 47 50 44Z" />
				<path class="fall f2 paper" d="M11 54C13 50 17 51 17 55C15 58 12 57 11 54Z" />
				<path class="fall f3 paper" d="M47 62C49 58 53 59 53 63C51 66 48 65 47 62Z" />
			{/if}
		{:else if suit === 'cups'}
			{#if scene}
				<!-- The fish that looks out of the Page of Cups' chalice. -->
				<g class="fish">
					<path class="paper" d="M27 31C26 23 28 16 33 14C36 13 40 14 42 17L38 19L42 21C41 25 39 29 38 31Z" />
					<circle cx="35" cy="17.5" r="1.1" class="dot" />
					<path d="M32 20C33 23 33 26 32 29M29 18L26 15M28 22L25 20" class="hair" />
				</g>
			{/if}
			<path class="paper" d="M18 31C18 47 26 53 32 53C38 53 46 47 46 31Z" />
			<ellipse class="paper" cx="32" cy="31" rx="14" ry="3.2" />
			<path d="M25 37L28 46L32 40L36 46L39 37" />
			<path class="paper" d="M30 53L30 57C27 58 27 61 30 62C29 71 23 78 17 81L47 81C41 78 35 71 34 62C37 61 37 58 34 57L34 53Z" />
			<path d="M17 81C17 84 47 84 47 81" />
			{#if scene}
				<path class="drop d1 paper" d="M12 40C13 43 14 45 12 46C10 45 11 43 12 40Z" />
				<path class="drop d2 paper" d="M52 34C53 37 54 39 52 40C50 39 51 37 52 34Z" />
				<path class="drop d3 paper" d="M9 58C10 61 11 63 9 64C7 63 8 61 9 58Z" />
			{/if}
		{:else if suit === 'swords'}
			<g class="sway">
				<path class="paper" d="M32 2L27.5 12L27.5 60L36.5 60L36.5 12Z" />
				<path d="M32 13L32 58" class="hair" />
				<path class="paper" d="M14 60C12 58 10 60 11 63C11 66 13 67 15 66L49 66C51 67 53 66 53 63C54 60 52 58 50 60Z" />
				<path class="paper" d="M29.5 66L29.5 80L34.5 80L34.5 66Z" />
				<path d="M29.5 70L34.5 72M29.5 75L34.5 77" class="hair" />
				<circle class="paper" cx="32" cy="85" r="4" />
				<!-- The crown at the point, with its hanging olive and palm. -->
				<path class="paper" d="M20 22L18 13L24 19L27 11L32 18L37 11L40 19L46 13L44 22L44 26C39 29 25 29 20 26Z" />
				<path d="M20 22C25 25 39 25 44 22" />
				<path d="M20 25C13 30 11 40 14 50M15 31L11 31M13 37L9 39M13 43L10 46" />
				<path d="M44 25C51 31 52 41 49 52M49 31L53 32M51 37L55 39M51 43L54 47" />
				{#if scene}
					<path class="glint" d="M32 30L33 34L37 35L33 36L32 40L31 36L27 35L31 34Z" />
				{/if}
			</g>
			{#if scene}
				<path class="fall f1 paper" d="M20 54C22 51 25 52 24 56C22 58 20 57 20 54Z" />
				<path class="fall f2 paper" d="M43 56C45 53 48 54 47 58C45 60 43 59 43 56Z" />
			{/if}
		{:else}
			<g transform={scene ? 'translate(0 10)' : undefined}>
				{#if scene}
					<g class="rays">
						<path d="M32 16L32 11M49 21L52 17M57 37L62 36M15 21L12 17M7 37L2 36" class="hair" />
					</g>
				{/if}
				<g class="coin">
					<circle class="paper" cx="32" cy="44" r="22" />
					<circle cx="32" cy="44" r="18.5" />
					<path d="M32 27L42 57.8L15.8 38.8L48.2 38.8L22 57.8Z" />
				</g>
			</g>
		{/if}
		{#if scene}
			<!-- The cloud each Ace's hand reaches out of. -->
			<g class="cloud">
				<path class="paper" d="M6 94C1 92 2 84 8 84C8 77 17 75 21 80C24 73 34 73 36 79C40 75 48 76 49 82C55 81 60 86 56 91C60 93 58 98 53 97L10 97C6 98 4 96 6 94Z" />
				<path d="M12 91C11 86 18 85 18 89C18 92 14 92 14 90M30 88C32 84 37 84 39 87M41 91C43 88 47 88 49 91" class="hair" />
			</g>
		{/if}
	</g>
</svg>

<style>
	.flourish {
		display: block;
		height: 100%;
		width: auto;
		overflow: visible;
		pointer-events: none;
		color: var(--ink);
	}
	.ink {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		filter: var(--ink0);
		animation: boil 0.72s steps(1) infinite;
	}
	/* Shapes that sit in front of other lines are filled with the page. */
	.paper {
		fill: var(--parchment);
	}
	.hair {
		stroke-width: 0.9;
	}
	.dot {
		fill: currentColor;
		stroke: none;
	}
	.glint {
		fill: currentColor;
		stroke: none;
	}
	@keyframes boil {
		0% { filter: var(--ink0); }
		33% { filter: var(--ink1); }
		66% { filter: var(--ink2); }
	}

	/* Each suit moves the way its card suggests. All of it is slow: this sits
	 * beside a working sheet and must never pull the eye from it. */
	.sway {
		transform-origin: 32px 92px;
		animation: sway 7s ease-in-out infinite;
	}
	.swords .sway {
		animation-duration: 9s;
	}
	@keyframes sway {
		0%, 100% { transform: rotate(-1.2deg); }
		50% { transform: rotate(1.4deg); }
	}
	.leaf {
		transform-box: fill-box;
		transform-origin: 0% 100%;
		animation: flutter 3.4s ease-in-out infinite;
	}
	.l2 { animation-delay: -1.1s; }
	.l3 { animation-delay: -2s; transform-origin: 100% 100%; }
	.l4 { animation-delay: -0.6s; transform-origin: 100% 100%; }
	@keyframes flutter {
		0%, 100% { transform: rotate(-7deg); }
		50% { transform: rotate(9deg); }
	}
	/* Spin each falling piece about itself, not about the drawing's corner. */
	.fall,
	.drop,
	.glint {
		transform-box: fill-box;
		transform-origin: center;
	}
	.fall {
		animation: fall 8s linear infinite;
		opacity: 0;
	}
	.f2 { animation-delay: -3s; }
	.f3 { animation-delay: -5.5s; }
	@keyframes fall {
		0% { transform: translate(0, -14px) rotate(0deg); opacity: 0; }
		15% { opacity: 1; }
		80% { opacity: 1; }
		100% { transform: translate(-5px, 26px) rotate(50deg); opacity: 0; }
	}
	.fish {
		animation: peek 11s ease-in-out infinite;
	}
	@keyframes peek {
		0%, 18%, 100% { transform: translateY(15px); }
		28%, 62% { transform: translateY(0); }
		40% { transform: translateY(0) rotate(-4deg); }
		52% { transform: translateY(0) rotate(3deg); }
		74% { transform: translateY(15px); }
	}
	.drop {
		animation: drip 5s ease-in infinite;
		opacity: 0;
	}
	.d2 { animation-delay: -1.8s; }
	.d3 { animation-delay: -3.4s; }
	@keyframes drip {
		0% { transform: translateY(-8px); opacity: 0; }
		20% { opacity: 1; }
		100% { transform: translateY(22px); opacity: 0; }
	}
	.glint {
		animation: glint 6.5s ease-in-out infinite;
		opacity: 0;
	}
	@keyframes glint {
		0%, 55% { transform: translateY(0); opacity: 0; }
		62% { opacity: 1; }
		88% { transform: translateY(28px); opacity: 1; }
		100% { transform: translateY(32px); opacity: 0; }
	}
	.coin {
		transform-origin: 32px 44px;
		animation: turn 12s ease-in-out infinite;
	}
	@keyframes turn {
		0%, 70%, 100% { transform: scaleX(1); }
		80% { transform: scaleX(0.12); }
		90% { transform: scaleX(1); }
	}
	.rays {
		animation: pulse 4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.25; }
		50% { opacity: 0.9; }
	}
	.cloud {
		animation: drift 10s ease-in-out infinite;
	}
	@keyframes drift {
		0%, 100% { transform: translateX(-1.5px); }
		50% { transform: translateX(1.5px); }
	}
	/* Still, not gone: the drawings stay, every movement stops. */
	@media (prefers-reduced-motion: reduce) {
		.ink,
		.sway,
		.leaf,
		.fish,
		.coin,
		.rays,
		.cloud,
		.glint {
			animation: none;
		}
		.fall,
		.drop,
		.glint {
			display: none;
		}
	}
</style>
