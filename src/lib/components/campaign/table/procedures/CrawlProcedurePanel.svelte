<script lang="ts">
	/**
	 * The Crawl/Camp placement of the finite-runner panel (Increment 4 Task 4):
	 * Area Sense, Overland Travel, No Rest for the Wicked, Patrol, We're
	 * Doomed. Same machinery as `OraclePanel` — one generic step UI, offered
	 * procedures filtered by content-pack phase.
	 */
	import OraclePanel from './OraclePanel.svelte';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { FiniteCommandInput } from '$lib/schemas/finite-command.schema';
	import type { SendCommandResult, TableSession } from '$lib/stores/campaign-session.svelte';

	let {
		role,
		session,
		roster,
		procedureTitles,
		onSendFiniteCommand
	}: {
		role: 'gm' | 'player';
		session: TableSession;
		roster: ActiveChallengeTenureView[];
		procedureTitles: Array<{ id: string; title: string; phase: string }>;
		onSendFiniteCommand: (command: FiniteCommandInput, commandId?: string) => Promise<SendCommandResult>;
	} = $props();
</script>

<OraclePanel {role} {session} {roster} phases={['crawl', 'camp']} heading="Crawl & Camp" {procedureTitles} {onSendFiniteCommand} />
