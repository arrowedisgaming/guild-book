<script lang="ts">
	import { page } from '$app/state';
	import { signIn } from '@auth/sveltekit/client';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let devEmail = $state('dev@example.com');
	let devName = $state('Dev User');

	const redirectTo = $derived(page.url.searchParams.get('callbackUrl') ?? '/characters');
	const authErrorMessage = $derived.by(() => {
		const authError = page.url.searchParams.get('error');
		if (!authError) return null;
		if (authError === 'OAuthAccountNotLinked' && data.user) {
			return 'That provider identity is already linked to a different Guild Book account and cannot be linked here.';
		}
		if (authError === 'OAuthAccountNotLinked') {
			return 'That provider is not linked yet. Sign in with your original provider, then link the other one from Account.';
		}
		if (authError === 'AccountNotLinked') {
			return 'That identity is already linked to a different Guild Book account.';
		}
		if (authError === 'SessionRequired') return 'Please sign in to manage your account.';
		return 'Sign-in could not be completed. Please try again.';
	});
</script>

<svelte:head>
	<title>Sign In — Guild Book</title>
</svelte:head>

<section class="login">
	<h1>Sign In</h1>
	<p class="lede">Save your adventurers and reach them from any device.</p>
	{#if authErrorMessage}
		<p class="auth-error" role="alert">{authErrorMessage}</p>
	{/if}

	<div class="providers">
		<button type="button" class="provider" onclick={() => signIn('google', { redirectTo })}>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
				<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
				<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
				<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
			</svg>
			Continue with Google
		</button>

		<button type="button" class="provider" onclick={() => signIn('discord', { redirectTo })}>
			<svg viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true">
				<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
			</svg>
			Continue with Discord
		</button>
	</div>

	{#if data.devLoginEnabled}
		<div class="divider"><span>dev only</span></div>
		<div class="dev-form">
			<label for="dev-email">Email</label>
			<input id="dev-email" type="email" bind:value={devEmail} />
			<label for="dev-name">Name</label>
			<input id="dev-name" type="text" bind:value={devName} />
			<button
				type="button"
				class="dev-submit"
				onclick={() => signIn('credentials', { email: devEmail, name: devName, redirectTo })}
			>
				Dev Sign In
			</button>
		</div>
	{/if}

	<p class="footnote">
		You can build an adventurer without signing in — an account is only needed to save it.
	</p>
</section>

<style>
	.login {
		max-width: 26rem;
		margin: 2rem auto;
		padding: 1.75rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--parchment) 92%, white);
		text-align: center;
	}
	h1 {
		margin: 0 0 0.25rem;
	}
	.lede {
		margin: 0 0 1.5rem;
		color: var(--ink-soft);
		font-size: 0.95rem;
	}
	.auth-error {
		margin: 0 0 1rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
		font-size: 0.85rem;
		text-align: left;
	}
	.providers {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.provider {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 0.6rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 0.95rem;
		cursor: pointer;
	}
	.provider:hover {
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.provider svg {
		width: 1.25rem;
		height: 1.25rem;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 1.25rem 0;
		color: var(--ink-soft);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: color-mix(in oklab, var(--ink) 20%, transparent);
	}
	.dev-form {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--accent) 40%, transparent);
		border-radius: 4px;
		text-align: left;
	}
	.dev-form label {
		font-size: 0.75rem;
		font-weight: 600;
	}
	.dev-form input {
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font-size: 0.9rem;
	}
	.dev-submit {
		margin-top: 0.4rem;
		padding: 0.5rem;
		border: none;
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.footnote {
		margin: 1.25rem 0 0;
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
</style>
