<script lang="ts">
	import WizardShell from '$lib/components/wizard/WizardShell.svelte';
	import LiveAnnouncer from '$lib/components/a11y/LiveAnnouncer.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<WizardShell>
	{@render children()}
</WizardShell>
<LiveAnnouncer />
