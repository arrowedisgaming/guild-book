<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { createSiteSearch } from './site-search.svelte';
	import { hitHref } from '$lib/search/rules-search';
	import { buildSnippet } from '$lib/search/snippets';
	import { sectionLabel } from '$lib/content/sections';

	let { packVersion }: { packVersion: string } = $props();

	// packVersion is captured once to instantiate the search engine for this
	// pack build; it is not expected to change during the component's life.
	// svelte-ignore state_referenced_locally
	const search = createSiteSearch(packVersion);
	let root = $state<HTMLElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	afterNavigate(() => search.close());

	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		if (target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)) return;
		if (target?.closest('[role="dialog"]')) return;
		e.preventDefault();
		input?.focus();
	}

	function onPointerDownOutside(e: PointerEvent) {
		if (root && !root.contains(e.target as Node)) search.close();
	}

	function onKeydown(e: KeyboardEvent) {
		const href = search.onKeydown(e);
		if (href) void goto(href);
	}

	function pick(index: number) {
		const hit = search.hits[index];
		search.close();
		void goto(hitHref(hit));
	}

	const listboxId = 'site-search-listbox';
	const optionId = (i: number) => `site-search-option-${i}`;
	let showList = $derived(search.open && search.query.trim().length > 0);

	// Keep the keyboard-active option visible inside the scrollable listbox.
	$effect(() => {
		if (search.active < 0) return;
		document.getElementById(optionId(search.active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onPointerDownOutside} />

<div class="site-search" bind:this={root}>
	<input
		bind:this={input}
		type="search"
		role="combobox"
		aria-label="Search the rules"
		aria-expanded={showList}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={search.active >= 0 ? optionId(search.active) : undefined}
		placeholder="Search rules… ( / )"
		value={search.query}
		onfocus={() => search.onFocus()}
		oninput={(e) => search.onInput(e.currentTarget.value)}
		onkeydown={onKeydown}
		oncompositionstart={() => search.setComposing(true)}
		oncompositionend={() => search.setComposing(false)}
	/>
	<span class="sr-only" role="status" aria-live="polite">
		{#if showList && search.status === 'ready'}{search.hits.length} results{/if}
	</span>

	{#if showList}
		<div class="dropdown">
			{#if search.status === 'loading' || search.status === 'idle'}
				<p class="state">loading the rulebook…</p>
			{:else if search.status === 'error'}
				<p class="state">search unavailable — <a href="/rules">browse the rules index</a></p>
			{:else if search.hits.length === 0}
				<p class="state">No rules match “{search.query}”.</p>
			{:else}
				<ul id={listboxId} role="listbox" aria-label="Rules search results">
					{#each search.hits as hit, i (hit.doc.id)}
						<li
							id={optionId(i)}
							role="option"
							aria-selected={i === search.active}
							class:active={i === search.active}
						>
							<button type="button" onpointerdown={(e) => e.preventDefault()} onclick={() => pick(i)}>
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
				<a class="all" href={`/rules?q=${encodeURIComponent(search.query)}`} onclick={() => search.close()}>
					All results for “{search.query}” →
				</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	.site-search {
		position: relative;
		min-width: 0;
	}
	.site-search input {
		width: 100%;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
		/* User-typed text, not book text: IM Fell (the body face) draws ASCII
		 * straight quotes as right-side curly marks, which reads as a bug while
		 * typing. Goudy renders neutral quote glyphs. */
		font-family: var(--font-sidebar);
		font-size: 0.9rem;
	}
	.dropdown {
		position: absolute;
		z-index: 30;
		top: calc(100% + 0.35rem);
		left: 0;
		width: min(28rem, calc(100vw - 2.5rem));
		max-height: min(60vh, 30rem);
		overflow-y: auto;
		background: var(--parchment);
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 6px;
		box-shadow: 0 8px 24px color-mix(in oklab, var(--ink) 25%, transparent);
	}
	.dropdown ul {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
	}
	.dropdown li button {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 0.5rem 0.6rem;
		border-radius: 4px;
		cursor: pointer;
		font: inherit;
	}
	.dropdown li.active button,
	.dropdown li button:hover {
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
	.state,
	.all {
		display: block;
		padding: 0.6rem 0.8rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
		margin: 0;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}
</style>
