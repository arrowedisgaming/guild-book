<script lang="ts">
	import { onMount } from 'svelte';
	import RuleArticle from './RuleArticle.svelte';
	import type { createRulesSidePanel } from './rules-side-panel.svelte';
	import { hitHref } from '$lib/search/rules-search';
	import { buildSnippet } from '$lib/search/snippets';
	import { sectionLabel } from '$lib/content/sections';
	import { clearPhraseHighlights, highlightPhrase } from '$lib/search/highlight-dom';
	import { slashTarget } from '$lib/search/slash-target.svelte';

	/**
	 * Rules search and reader docked beside the owner's sheet. All state lives
	 * in `panel` (created by the page), so it survives this component being
	 * unmounted when the viewport drops below the wide breakpoint.
	 */
	let { panel }: { panel: ReturnType<typeof createRulesSidePanel> } = $props();

	let panelEl = $state<HTMLElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);
	let articleEl = $state<HTMLElement | null>(null);

	const listboxId = 'rules-panel-listbox';
	const optionId = (i: number) => `rules-panel-option-${i}`;
	const hasQuery = $derived(panel.query.trim().length > 0);
	const showList = $derived(panel.view === 'search' && hasQuery && panel.status === 'ready' && panel.hits.length > 0);

	// The normal search link when the rule came from the active hit; otherwise
	// (a rule reached through a link inside another rule) its section anchor.
	const openHref = $derived.by(() => {
		const hit = panel.hits[panel.active];
		if (hit && hit.doc.id === panel.ruleId) return hitHref(hit);
		return panel.ruleSection ? `/rules/${panel.ruleSection}#${panel.ruleId}` : '/rules';
	});

	function focusInput() {
		input?.focus();
	}

	onMount(() => {
		slashTarget.focus = focusInput;
		return () => {
			if (slashTarget.focus === focusInput) slashTarget.focus = null;
		};
	});

	function back() {
		panel.backToResults();
		focusInput();
	}

	// Escape anywhere in the rule view (not only the input) returns to results.
	$effect(() => {
		const el = panelEl;
		if (!el) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.defaultPrevented || panel.view !== 'rule') return;
			e.preventDefault();
			back();
		};
		el.addEventListener('keydown', onKey);
		return () => el.removeEventListener('keydown', onKey);
	});

	// A link inside a rule that points at another rule opens it here instead of
	// navigating away. Modifier clicks and every other link behave normally.
	$effect(() => {
		const el = articleEl;
		if (!el) return;
		const onClick = (e: MouseEvent) => {
			if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const anchor = (e.target as Element | null)?.closest('a');
			if (!anchor || !el.contains(anchor)) return;
			const url = new URL(anchor.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			if (!/^\/rules\/[^/]+\/?$/.test(url.pathname) || url.hash.length < 2) return;
			// A malformed % sequence cannot name a rule: leave the click to the
			// browser's ordinary navigation rather than swallowing it.
			let id: string;
			try {
				id = decodeURIComponent(url.hash.slice(1));
			} catch {
				return;
			}
			e.preventDefault();
			void panel.openRuleById(id);
		};
		el.addEventListener('click', onClick);
		return () => el.removeEventListener('click', onClick);
	});

	// Once a rule renders: highlight the searched phrase and scroll the panel
	// (never the page — the sheet must not move) to it, or back to the top.
	$effect(() => {
		const article = articleEl;
		const root = panelEl;
		const rule = panel.rule;
		const phrase = panel.phrase;
		if (!article || !root || !rule || panel.view !== 'rule') return;
		// Widened via Node: the Workers types' Element.append overload makes
		// HTMLElement fail a direct ParentNode check, though the DOM one fits.
		clearPhraseHighlights(root as Node as ParentNode);
		const mark = phrase ? highlightPhrase(article, phrase) : null;
		if (mark) {
			const offset = mark.getBoundingClientRect().top - root.getBoundingClientRect().top;
			root.scrollTop += offset - root.clientHeight / 2;
		} else {
			root.scrollTop = 0;
		}
	});

	// Keep the keyboard-active option visible while the user is arrowing.
	$effect(() => {
		if (panel.active < 0 || !showList || document.activeElement !== input) return;
		document.getElementById(optionId(panel.active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

<aside class="rules-panel" aria-label="Rules reference" bind:this={panelEl}>
	<input
		bind:this={input}
		type="search"
		role="combobox"
		aria-label="Search the rules beside the sheet"
		aria-expanded={showList}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={showList && panel.active >= 0 ? optionId(panel.active) : undefined}
		placeholder="Search rules… ( / )"
		value={panel.query}
		onfocus={() => panel.onFocus()}
		oninput={(e) => panel.onInput(e.currentTarget.value)}
		onkeydown={(e) => panel.onKeydown(e)}
		oncompositionstart={() => panel.setComposing(true)}
		oncompositionend={() => panel.setComposing(false)}
	/>

	{#if panel.view === 'search'}
		<p class="count" role="status" aria-live="polite">
			{#if hasQuery && panel.status === 'ready'}
				{panel.hits.length} {panel.hits.length === 1 ? 'result' : 'results'}
			{/if}
		</p>
		{#if !hasQuery}
			<p class="state">Search the rules without leaving your sheet.</p>
		{:else if panel.status === 'loading' || panel.status === 'idle'}
			<p class="state">loading the rulebook…</p>
		{:else if panel.status === 'error'}
			<p class="state">search unavailable — <a href="/rules">browse the rules index</a></p>
		{:else if panel.hits.length === 0}
			<p class="state">No rules match “{panel.query}”.</p>
		{:else}
			<ul id={listboxId} role="listbox" aria-label="Rules search results">
				{#each panel.hits as hit, i (hit.doc.id)}
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === panel.active}
						class:active={i === panel.active}
					>
						<!-- tabindex -1: options are reached via aria-activedescendant and
						     arrows from the input, as in the header search. -->
						<button
							type="button"
							tabindex="-1"
							onpointerdown={(e) => e.preventDefault()}
							onclick={() => void panel.openHit(i)}
						>
							<span class="title">{hit.doc.title}</span>
							<span class="crumb">{sectionLabel(hit.doc.section)}</span>
							<span class="snippet">
								{#each buildSnippet(hit.doc.body, hit.terms, 220, hit.phrase) as part}
									{#if part.marked}<mark>{part.text}</mark>{:else}{part.text}{/if}
								{/each}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<div class="rule-bar">
			<button type="button" class="back" onclick={back}>← Results</button>
			<a class="open" href={openHref} target="_blank" rel="noopener">Open in rules ↗</a>
		</div>
		{#if panel.ruleStatus === 'error'}
			<p class="state" role="alert">This rule could not be loaded.</p>
		{:else if panel.ruleStatus === 'ready' && panel.rule}
			{#key panel.rule}
				<div class="rule-wrap" bind:this={articleEl}>
					<RuleArticle rule={panel.rule} />
				</div>
			{/key}
		{:else}
			<p class="state">loading the rule…</p>
		{/if}
	{/if}
</aside>

<style>
	.rules-panel {
		position: sticky;
		top: 1rem;
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		min-width: 0;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		background: var(--parchment);
	}
	input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
		/* Same reasoning as the header search: user-typed text uses Goudy so
		 * straight quotes render neutrally. */
		font-family: var(--font-sidebar);
		font-size: 0.9rem;
	}
	.count {
		margin: 0.35rem 0 0;
		min-height: 1em;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.state {
		margin: 0.4rem 0;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	ul {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
	}
	li button {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 0.5rem 0.6rem;
		border-radius: 4px;
		cursor: pointer;
		color: inherit;
		font: inherit;
	}
	li.active button,
	li button:hover {
		background: color-mix(in oklab, var(--accent) 14%, transparent);
	}
	.title {
		display: inline;
		font-family: var(--font-subhead);
		font-weight: 600;
	}
	.crumb {
		margin-left: 0.5rem;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.snippet {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
		line-height: 1.4;
	}
	.snippet mark {
		background: color-mix(in oklab, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 2px;
	}
	.rule-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.6rem;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.back {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
	}
	.open {
		color: var(--accent);
	}
	.rule-wrap :global(.rule) {
		padding-top: 0.6rem;
		border-bottom: none;
	}
	/* Runtime-inserted by highlight-dom.ts (same look as the section page). */
	.rule-wrap :global(mark.phrase-hl) {
		background: color-mix(in oklab, var(--accent) 32%, transparent);
		color: inherit;
		border-radius: 2px;
		padding: 0 0.05em;
	}
</style>
