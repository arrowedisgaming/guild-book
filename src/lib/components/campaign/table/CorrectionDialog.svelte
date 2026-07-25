<script lang="ts">
	/**
	 * The GM's compensating-correction form (Increment 4 Task 5). Never an
	 * editor: it names a legal card move, the event it compensates for, and a
	 * required reason. The engine applies the move through the ordinary
	 * reducer and appends `correction-applied` — the journal is append-only.
	 *
	 * Sources offered are zones whose identities the GM can actually SEE in
	 * their own projection (public zones, the discard tops, the GM hand,
	 * pending zones). A player's hidden hand is deliberately absent: the GM
	 * cannot name a card they cannot see, and repairing a mis-play into a
	 * private hand is done by moving the PUBLIC card, not by reaching into the
	 * hand.
	 */
	import type { SendCommandResult, TableSession, WireSessionEventLike } from '$lib/stores/campaign-session.svelte';
	import type { SessionGmProjection } from '$lib/types/session';

	let {
		session,
		events,
		onSendCorrectionCommand
	}: {
		session: TableSession;
		events: WireSessionEventLike[];
		onSendCorrectionCommand: (command: Record<string, unknown>, commandId?: string) => Promise<SendCommandResult>;
	} = $props();

	let open = $state(false);
	let sourceZoneId = $state('');
	let cardId = $state('');
	let destinationZoneId = $state('');
	let targetEventId = $state('');
	let reason = $state('');
	let pending = $state(false);
	let error = $state<string | null>(null);

	const gm = $derived(session.projection as SessionGmProjection);

	interface ZoneOption {
		id: string;
		cards: Array<{ id: string; label: string }>;
	}
	const sourceZones = $derived.by((): ZoneOption[] => {
		const zones: ZoneOption[] = gm.public.publicZones.map((zone) => ({
			id: zone.id,
			cards: zone.cards.filter((card) => !card.hidden).map((card) => ({ id: card.id, label: card.label }))
		}));
		zones.push({ id: 'gmHand', cards: gm.gmHand.filter((card) => !card.hidden).map((card) => ({ id: card.id, label: card.label })) });
		for (const zone of gm.gmPendingZones) {
			zones.push({ id: zone.id, cards: zone.cards.filter((card) => !card.hidden).map((card) => ({ id: card.id, label: card.label })) });
		}
		const discardTop = gm.public.playerDiscardTop;
		if (discardTop && !discardTop.hidden) zones.push({ id: 'playerDiscard', cards: [{ id: discardTop.id, label: discardTop.label }] });
		const majorTop = gm.public.majorDiscardTop;
		if (majorTop && !majorTop.hidden) zones.push({ id: 'majorDiscard', cards: [{ id: majorTop.id, label: majorTop.label }] });
		return zones.filter((zone) => zone.cards.length > 0);
	});

	const cardsInSource = $derived(sourceZones.find((zone) => zone.id === sourceZoneId)?.cards ?? []);
	const destinationOptions = $derived([
		...gm.public.publicZones.map((zone) => zone.id),
		'playerDiscard',
		'majorDiscard',
		'gmHand'
	]);
	const recentEvents = $derived(events.slice(-20).reverse());

	async function submit(): Promise<void> {
		if (pending || !sourceZoneId || !cardId || !destinationZoneId || !targetEventId || !reason.trim()) return;
		pending = true;
		error = null;
		const result = await onSendCorrectionCommand({
			kind: 'move-card',
			targetEventId,
			reason: reason.trim(),
			sourceZoneId,
			cardId,
			destinationZoneId
		});
		pending = false;
		if (result.ok) {
			open = false;
			sourceZoneId = cardId = destinationZoneId = targetEventId = '';
			reason = '';
		} else {
			error = result.message ?? 'The correction was refused';
		}
	}
</script>

<div class="correction">
	<button type="button" onclick={() => (open = !open)} data-testid="open-correction" aria-expanded={open}>
		{open ? 'Close corrections' : 'Apply a correction'}
	</button>

	{#if open}
		<form class="dialog" data-testid="correction-dialog" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
			<label>
				Compensates for
				<select bind:value={targetEventId} data-testid="correction-target" required>
					<option value="">Choose the event…</option>
					{#each recentEvents as event (event.id)}
						<option value={String(event.id)}>#{event.id} {event.kind}</option>
					{/each}
				</select>
			</label>
			<label>
				From zone
				<select bind:value={sourceZoneId} data-testid="correction-source" required>
					<option value="">Choose…</option>
					{#each sourceZones as zone (zone.id)}
						<option value={zone.id}>{zone.id}</option>
					{/each}
				</select>
			</label>
			<label>
				Card
				<select bind:value={cardId} data-testid="correction-card" required>
					<option value="">Choose…</option>
					{#each cardsInSource as card (card.id)}
						<option value={card.id}>{card.label}</option>
					{/each}
				</select>
			</label>
			<label>
				To zone
				<select bind:value={destinationZoneId} data-testid="correction-destination" required>
					<option value="">Choose…</option>
					{#each destinationOptions as zoneId (zoneId)}
						<option value={zoneId}>{zoneId}</option>
					{/each}
				</select>
			</label>
			<label>
				Reason (required, audited)
				<input type="text" bind:value={reason} data-testid="correction-reason" required maxlength="500" />
			</label>
			<button type="submit" disabled={pending || !reason.trim()} data-testid="submit-correction">Apply correction</button>
			{#if error}<p class="error" role="alert" data-testid="correction-error">{error}</p>{/if}
		</form>
	{/if}
</div>

<style>
	.correction {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.dialog {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.8rem;
		border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.9rem;
	}
	.error {
		margin: 0;
		font-size: 0.9rem;
		color: var(--danger, crimson);
	}
</style>
