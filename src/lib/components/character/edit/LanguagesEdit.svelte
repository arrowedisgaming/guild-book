<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { NamedEntry } from '$lib/types/content-pack';
	import {
		MAX_LANGUAGE_LENGTH,
		addLanguage,
		availableLanguages,
		knowsLanguage
	} from '$lib/character/languages';
	import Prose from '$lib/components/ui/Prose.svelte';

	interface Props {
		char: GuildBookCharacterData;
		languages: NamedEntry[];
		onChange: () => void;
	}
	let { char = $bindable(), languages, onChange }: Props = $props();

	let pickId = $state('');
	let custom = $state('');
	let notice = $state('');

	// Pack languages this adventurer has not learned yet — the dropdown only
	// ever offers tongues they do not already speak.
	const available = $derived(availableLanguages(char.languages, languages));
	const picked = $derived(available.find((entry) => entry.id === pickId) ?? null);
	// Pack descriptions run to several paragraphs; the picker only needs enough
	// to tell the tongues apart, so preview the first one and leave the rest to
	// the rules reference.
	const pickedBlurb = $derived(picked?.description?.split(/\n\s*\n/)[0]?.trim() ?? '');

	function commit(value: string) {
		const next = addLanguage(char.languages, value);
		if (next === char.languages) {
			notice = `${value.trim()} is already on the sheet.`;
			return false;
		}
		char.languages = next;
		notice = '';
		onChange();
		return true;
	}

	function addPicked() {
		if (!picked) return;
		if (commit(picked.name)) pickId = '';
	}

	function addCustom() {
		if (!custom.trim()) return;
		if (commit(custom)) custom = '';
	}

	function remove(i: number) {
		char.languages = char.languages.filter((_, idx) => idx !== i);
		notice = '';
		onChange();
	}

	// Enter in the custom field adds rather than submitting anything upstream.
	function onCustomKey(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		addCustom();
	}

	const customIsDuplicate = $derived(
		custom.trim().length > 0 && knowsLanguage(char.languages, custom)
	);
</script>

<div class="languages-edit">
	{#if char.languages.length}
		<ul class="known">
			{#each char.languages as language, i (`${language}-${i}`)}
				<li>
					<span>{language}</span>
					<button
						type="button"
						class="remove"
						onclick={() => remove(i)}
						aria-label="Remove {language}"
					>
						✕
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="hint">No languages recorded yet.</p>
	{/if}

	<div class="add">
		<select bind:value={pickId} aria-label="Language">
			<option value="">
				{available.length ? 'Add a language…' : 'Every language in the book is known'}
			</option>
			{#each available as language (language.id)}
				<option value={language.id}>{language.name}</option>
			{/each}
		</select>
		<button type="button" aria-label="Add language" disabled={!picked} onclick={addPicked}>
			Add
		</button>
	</div>
	{#if pickedBlurb}
		<Prose class="ldesc" text={pickedBlurb} />
	{/if}

	<div class="add">
		<input
			type="text"
			bind:value={custom}
			maxlength={MAX_LANGUAGE_LENGTH}
			placeholder="Or name your own — a dialect, a cant, a dead tongue"
			aria-label="Custom language"
			onkeydown={onCustomKey}
		/>
		<button
			type="button"
			aria-label="Add custom language"
			disabled={!custom.trim() || customIsDuplicate}
			onclick={addCustom}
		>
			Add
		</button>
	</div>

	{#if notice}<p class="notice">{notice}</p>{/if}
</div>

<style>
	.languages-edit {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.known {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.known li {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 999px;
		font-size: 0.9rem;
	}
	.remove {
		border: none;
		background: none;
		color: var(--ink-soft);
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
	}
	.add {
		display: flex;
		gap: 0.5rem;
	}
	.add select,
	.add input {
		flex: 1;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
		font-size: 0.9rem;
	}
	.add button {
		padding: 0.45rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.add button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.languages-edit :global(.ldesc) {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.notice {
		margin: 0;
		font-size: 0.85rem;
		color: var(--accent);
	}
</style>
