<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';

	const STEP = 0;

	let name = $state($wizard.character.name);
	let pronouns = $state($wizard.character.pronouns);
	let appearance = $state($wizard.character.appearance);

	function persist() {
		wizard.updateCharacter((c) => ({ ...c, name, pronouns, appearance }));
	}

	function next() {
		persist();
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Identity — Guild Book</title></svelte:head>

<h1>Who are you?</h1>
<p class="lede">Name your adventurer. You can change any of this later.</p>

<div class="fields">
	<label>
		<span>Name</span>
		<input type="text" bind:value={name} oninput={persist} placeholder="e.g. Phynn, Dorian…" />
	</label>
	<label>
		<span>Pronouns</span>
		<input type="text" bind:value={pronouns} oninput={persist} placeholder="e.g. she/her" />
	</label>
	<label>
		<span>Appearance</span>
		<textarea bind:value={appearance} oninput={persist} rows="3" placeholder="What do you look like?"></textarea>
	</label>
</div>

<WizardNav onContinue={next} continueDisabled={!name.trim()} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1.5rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	label span {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	input,
	textarea {
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
</style>
