<script lang="ts">
	interface Member {
		id: string;
		displayName: string;
		joinedAt: Date;
		leftAt: Date | null;
		removedAt: Date | null;
	}

	interface Tenure {
		id: string;
		membershipId: string;
		characterId: string;
		characterName: string;
		startedAt: Date;
		endedAt: Date | null;
		endReason: string | null;
	}

	let {
		members,
		tenures,
		role,
		readOnly = false
	}: {
		members: Member[];
		tenures: Tenure[];
		role: 'gm' | 'player';
		readOnly?: boolean;
	} = $props();

	let activeMembers = $derived(
		members.filter((member) => member.leftAt === null && member.removedAt === null)
	);
	let formerMembers = $derived(
		members.filter((member) => member.leftAt !== null || member.removedAt !== null)
	);
	let activeTenures = $derived(tenures.filter((tenure) => tenure.endedAt === null));
	let formerTenures = $derived(tenures.filter((tenure) => tenure.endedAt !== null));

	function activeAdventurer(membershipId: string) {
		return activeTenures.find((tenure) => tenure.membershipId === membershipId);
	}

	function confirmRemoval(event: SubmitEvent) {
		if (!confirm('Remove this member from the campaign? Their active tenure will end.')) {
			event.preventDefault();
		}
	}
</script>

<section class="campaign-roster" aria-labelledby="campaign-roster-heading">
	<div class="section-head">
		<div>
			<h2 id="campaign-roster-heading">Guild members</h2>
			<p>
				{activeMembers.length} active {activeMembers.length === 1 ? 'member' : 'members'} ·
				{activeTenures.length} active {activeTenures.length === 1 ? 'adventurer' : 'adventurers'}
			</p>
		</div>
	</div>

	{#if activeMembers.length === 0}
		<p class="empty">No players have joined yet.</p>
	{:else}
		<ul class="members">
			{#each activeMembers as member (member.id)}
				{@const adventurer = activeAdventurer(member.id)}
				<li>
					<div>
						<strong>{member.displayName}</strong>
						<span>{adventurer?.characterName ?? 'Observer — no adventurer attached'}</span>
					</div>
					{#if role === 'gm' && !readOnly}
						<form method="POST" action="?/remove" onsubmit={confirmRemoval}>
							<input type="hidden" name="membershipId" value={member.id} />
							<button type="submit">Remove member</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if formerTenures.length > 0 || formerMembers.length > 0}
		<section class="past" aria-labelledby="campaign-history-heading">
			<h3 id="campaign-history-heading">Campaign history</h3>
			{#if formerTenures.length > 0}
				<h4>Past adventurers</h4>
				<ul class="history">
					{#each formerTenures as tenure (tenure.id)}
						<li>{tenure.characterName} — {tenure.endReason ?? 'ended'}</li>
					{/each}
				</ul>
			{/if}
			{#if formerMembers.length > 0}
				<h4>Former members</h4>
				<ul class="history">
					{#each formerMembers as member (member.id)}
						<li>{member.displayName} — {member.removedAt ? 'removed' : 'left'}</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</section>

<style>
	.campaign-roster {
		padding: 1.25rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.section-head h2,
	.section-head p {
		margin: 0;
	}
	.section-head p,
	.empty {
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.members,
	.history {
		list-style: none;
		padding: 0;
	}
	.members {
		margin: 1rem 0 0;
	}
	.members li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 0;
		border-top: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.members strong,
	.members span {
		display: block;
	}
	.members span {
		margin-top: 0.15rem;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	button {
		border: none;
		background: none;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.past {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	h3,
	h4 {
		margin-bottom: 0.35rem;
		font-size: 1rem;
	}
	.history {
		margin: 0;
		color: var(--ink-soft);
	}
</style>
