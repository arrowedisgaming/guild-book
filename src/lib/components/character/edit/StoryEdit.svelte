<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';

	interface Props {
		char: GuildBookCharacterData;
		motifCount: number;
		onChange: () => void;
	}
	let { char = $bindable(), motifCount, onChange }: Props = $props();

	function setMotif(i: number, value: string) {
		const motifs = [...char.motifs];
		motifs[i] = value;
		char.motifs = motifs.map((m) => m.trim()).filter(Boolean).slice(0, motifCount);
		onChange();
	}

	// Render motifCount rows, padding with empties.
	const motifRows = $derived(
		Array.from({ length: motifCount }, (_, i) => char.motifs[i] ?? '')
	);
</script>

<div class="story-edit">
	<div class="two">
		<label><span>Name</span><input type="text" bind:value={char.name} oninput={onChange} /></label>
		<label><span>Pronouns</span><input type="text" bind:value={char.pronouns} oninput={onChange} /></label>
	</div>
	<label><span>Appearance</span><textarea rows="2" bind:value={char.appearance} oninput={onChange}></textarea></label>
	<label><span>Quest</span><textarea rows="2" bind:value={char.quest} oninput={onChange}></textarea></label>
	<div class="motifs">
		<span class="lbl">Motifs (up to {motifCount})</span>
		{#each motifRows as m, i (i)}
			<input type="text" value={m} oninput={(e) => setMotif(i, e.currentTarget.value)} placeholder="descriptor + profession" />
		{/each}
	</div>
	<label><span>Notes</span><textarea rows="3" bind:value={char.notes} oninput={onChange}></textarea></label>
</div>

<style>
	.story-edit {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.two {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: 0.75rem;
	}
	label,
	.motifs {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	span,
	.lbl {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
	}
	input,
	textarea {
		padding: 0.5rem 0.65rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
		font-size: 0.95rem;
	}
	.motifs input {
		margin-bottom: 0.3rem;
	}
</style>
