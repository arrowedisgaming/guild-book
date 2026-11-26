<script lang="ts">
	import { fuzzyFilter } from '$lib/utils/fuzzy';

	/**
	 * A text box that filters a long list as you type, in place of a long
	 * dropdown. Follows the ARIA combobox pattern: the input keeps focus, the
	 * arrow keys move through the list, Enter takes the highlighted entry and
	 * Escape closes it.
	 *
	 * Two uses. By default a pick is an action (`onPick`) and the box clears
	 * for the next one. With `value` bound it is a form field: the box shows
	 * the chosen entry, and emptying it clears the choice.
	 */
	export interface PickerOption {
		id: string;
		label: string;
		/** A quieter second piece of text, e.g. an item's tier. Searched too. */
		detail?: string;
	}
	interface Props {
		options: PickerOption[];
		/** The accessible name of the box. */
		label: string;
		placeholder?: string;
		disabled?: boolean;
		onPick?: (id: string) => void;
		/** Bind to use as a form field; '' means nothing chosen. */
		value?: string;
		/** Shown in the list when nothing matches. */
		emptyText?: string;
	}
	let {
		options,
		label,
		placeholder = '',
		disabled = false,
		onPick,
		value = $bindable(),
		emptyText = 'Nothing matches.'
	}: Props = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;
	const isField = $derived(value !== undefined);
	const chosen = $derived(isField ? options.find((o) => o.id === value) : undefined);

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	// In field mode the box shows the choice until the user starts typing.
	let typing = $state(false);
	const shown = $derived(isField && !typing ? (chosen?.label ?? '') : query);
	const results = $derived(
		fuzzyFilter(isField && !typing ? '' : query, options, (o) => `${o.label} ${o.detail ?? ''}`)
	);
	let list: HTMLUListElement | undefined = $state();

	function pick(option: PickerOption) {
		// The list can still be on screen when the box is disabled mid-use.
		if (disabled) return;
		if (isField) value = option.id;
		typing = false;
		query = '';
		open = false;
		// The list may be shorter next time (a picked entry can leave it).
		active = 0;
		onPick?.(option.id);
	}
	$effect(() => {
		if (disabled) open = false;
	});
	function onInput(event: Event & { currentTarget: HTMLInputElement }) {
		query = event.currentTarget.value;
		typing = true;
		open = true;
		active = 0;
		// Emptying a field is how its choice is cleared.
		if (isField && !query.trim() && value) {
			value = '';
			onPick?.('');
		}
	}
	function move(delta: number) {
		if (!open) {
			open = true;
			return;
		}
		if (!results.length) return;
		active = (active + delta + results.length) % results.length;
		// Keep the highlighted entry in view inside the scrolling list.
		list?.children[active]?.scrollIntoView({ block: 'nearest' });
	}
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			move(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			move(-1);
		} else if (event.key === 'Enter') {
			// Never submit a surrounding form from the picker.
			event.preventDefault();
			const option = open ? results[active] : undefined;
			if (option) pick(option);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			open = false;
			typing = false;
			query = '';
		}
	}
	function onBlur() {
		open = false;
		typing = false;
		query = '';
	}
</script>

<div class="picker">
	<input
		type="text"
		role="combobox"
		aria-label={label}
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls={listId}
		aria-activedescendant={open && results[active] ? `${uid}-o-${results[active].id}` : undefined}
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		{placeholder}
		{disabled}
		value={shown}
		oninput={onInput}
		onkeydown={onKeydown}
		onfocus={() => { open = true; active = 0; }}
		onclick={() => (open = true)}
		onblur={onBlur}
	/>
	<svg class="mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
		<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" />
		<path d="M10.5 10.5L14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
	</svg>
	<ul id={listId} role="listbox" aria-label="Suggestions" hidden={!open} bind:this={list}>
		{#each results as option, i (option.id)}
			<!-- The input keeps focus: preventDefault on mousedown stops the
			     click from blurring it and closing the list first. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				id="{uid}-o-{option.id}"
				role="option"
				aria-selected={i === active}
				class:active={i === active}
				onmousedown={(event) => event.preventDefault()}
				onmousemove={() => (active = i)}
				onclick={() => pick(option)}
			>
				<span class="olabel">{option.label}</span>
				{#if option.detail}<span class="odetail">{option.detail}</span>{/if}
			</li>
		{:else}
			<li class="none" role="presentation">{emptyText}</li>
		{/each}
	</ul>
</div>

<style>
	.picker {
		position: relative;
		flex: 1 1 14rem;
		min-width: 0;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		min-height: 2.5rem;
		padding: 0.45rem 2rem 0.45rem 0.65rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
		font-size: 0.95rem;
	}
	input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.mark {
		position: absolute;
		top: 50%;
		right: 0.65rem;
		translate: 0 -50%;
		color: var(--ink-soft);
		pointer-events: none;
	}
	ul {
		position: absolute;
		z-index: 15;
		top: calc(100% + 3px);
		left: 0;
		right: 0;
		max-height: 17rem;
		margin: 0;
		padding: 0.25rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
		border: 1px solid color-mix(in oklab, var(--ink) 35%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		box-shadow: 0 8px 20px -8px color-mix(in oklab, var(--ink) 45%, transparent);
	}
	li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0.55rem;
		border-radius: 2px;
		cursor: pointer;
	}
	li.active {
		background: var(--accent);
		color: var(--parchment);
	}
	.odetail {
		flex: none;
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	li.active .odetail {
		color: inherit;
	}
	.none {
		cursor: default;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	@media (pointer: coarse) {
		input {
			min-height: 44px;
		}
		li {
			min-height: 44px;
			align-items: center;
		}
	}
</style>
