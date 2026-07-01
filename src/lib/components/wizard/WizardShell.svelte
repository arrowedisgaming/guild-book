<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { announce } from '$lib/stores/announcer';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	let currentPath = $derived(page.url.pathname);
	let currentStepIndex = $derived(WIZARD_STEPS.findIndex((s) => currentPath.endsWith(s.id)));
	let onStepRoute = $derived(currentStepIndex !== -1);

	// Deep-link guard: visiting a step URL with no active draft starts one.
	$effect(() => {
		if (onStepRoute && !$wizard.active) {
			wizard.start();
			void goto(WIZARD_STEPS[0].path, { replaceState: true });
		}
	});

	let lastAnnouncedStep = -1;
	$effect(() => {
		if (currentStepIndex !== -1 && currentStepIndex !== lastAnnouncedStep) {
			lastAnnouncedStep = currentStepIndex;
			const step = WIZARD_STEPS[currentStepIndex];
			announce(`Step ${currentStepIndex + 1} of ${WIZARD_STEPS.length}: ${step.label}.`);
		}
	});

	async function confirmStartOver() {
		if (!confirm('Discard this adventurer and start over? All entered data will be cleared.')) return;
		wizard.reset();
		wizard.start();
		announce('Wizard reset. Starting fresh.');
		await goto(WIZARD_STEPS[0].path, { replaceState: true });
	}
</script>

<div class="wizard">
	{#if onStepRoute}
		<nav class="steps" aria-label="Adventurer creation progress">
			<div class="steps-row">
				<ol>
					{#each WIZARD_STEPS as step, i (step.id)}
						{@const isActive = i === currentStepIndex}
						{@const isComplete = $wizard.completedSteps.includes(i)}
						{@const isAccessible = i <= $wizard.currentStep || isComplete}
						<li>
							{#if i > 0}<span class="sep">/</span>{/if}
							{#if isAccessible}
								<a
									href={step.path}
									class:active={isActive}
									class:complete={isComplete && !isActive}
									aria-current={isActive ? 'step' : undefined}
								>
									<span class="full">{step.label}</span><span class="num">{i + 1}</span>
								</a>
							{:else}
								<span class="locked"><span class="full">{step.label}</span><span class="num">{i + 1}</span></span>
							{/if}
						</li>
					{/each}
				</ol>
				<button type="button" class="startover" onclick={confirmStartOver}>Start over</button>
			</div>
			<div class="bar">
				<div class="fill" style="width: {((currentStepIndex + 1) / WIZARD_STEPS.length) * 100}%"></div>
			</div>
		</nav>
	{/if}

	{#key `${currentPath}-${$wizard.nonce}`}
		<div class="step-content">{@render children()}</div>
	{/key}
</div>

<style>
	.wizard {
		max-width: 48rem;
		margin: 0 auto;
	}
	.steps {
		margin-bottom: 2rem;
	}
	.steps-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		list-style: none;
		margin: 0;
		padding: 0;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	li {
		display: flex;
		align-items: center;
	}
	.sep {
		margin: 0 0.4rem;
		color: var(--ink-soft);
	}
	a,
	.locked {
		text-decoration: none;
		color: var(--ink-soft);
	}
	a.active {
		color: var(--accent);
		font-weight: 600;
	}
	a.complete {
		color: var(--ink);
	}
	.locked {
		opacity: 0.5;
	}
	.num {
		display: none;
	}
	.startover {
		flex-shrink: 0;
		border: none;
		background: none;
		color: var(--ink-soft);
		font-size: 0.75rem;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.bar {
		margin-top: 0.75rem;
		height: 3px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.fill {
		height: 3px;
		border-radius: 999px;
		background: var(--accent);
		transition: width 0.3s ease;
	}
	@media (max-width: 560px) {
		.full {
			display: none;
		}
		.num {
			display: inline;
		}
	}
</style>
