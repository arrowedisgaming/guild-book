import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getEnv } from '$lib/server/auth';
import {
	requireCampaignAccess,
	requireCampaignReadAccess,
	type CampaignRole
} from '$lib/server/campaign/access';
import {
	archiveCampaign,
	leaveCampaign,
	removeCampaignMember
} from '$lib/server/campaign/membership';
import {
	listEligibleAdventurersForUser,
	loadCampaignRosterView
} from '$lib/server/campaign/page-data';
import {
	closeCampaignInvite,
	getCampaignInvite,
	loadCampaignProjection,
	openCampaignInvite,
	rotateCampaignInvite
} from '$lib/server/campaign/service';
import { attachAdventurer, replaceAdventurer } from '$lib/server/campaign/tenure';
import { getDb } from '$lib/server/db';
import { campaignCursor } from '$lib/server/session/repository';

export const load: PageServerLoad = async (event) => {
	const role = await requireCampaignReadAccess(event, event.params.id);
	const db = await getDb(event);
	const [campaign, rosterView, cursor] = await Promise.all([
		loadCampaignProjection(db, role),
		loadCampaignRosterView(db, event.params.id),
		// Seeds the client's ~5s dashboard poller (fix round 1 / plan Step 2):
		// the same campaign-wide cursor `/sync` tracks — membership, tenure,
		// and character events all bump it, not just session events — so a
		// cursor change here is exactly "the roster this page rendered may now
		// be stale."
		campaignCursor(db, event.params.id)
	]);
	if (!campaign) throw error(404, 'Campaign not found');

	const eligibleAdventurers =
		role.kind === 'player' && campaign.archivedAt === null
			? await listEligibleAdventurersForUser(db, role.userId)
			: [];
	const activePlayerTenure =
		role.kind === 'player'
			? rosterView.tenures.find(
					(tenure) => tenure.membershipId === role.membershipId && tenure.endedAt === null
				)
			: undefined;
	let inviteUrl: string | null = null;
	if (role.kind === 'gm' && campaign.archivedAt === null && campaign.joinOpen) {
		const secret = requireInviteSecret(event);
		const invite = await getCampaignInvite(db, {
			campaignId: event.params.id,
			ownerUserId: role.userId,
			secret
		});
		if (invite.ok) inviteUrl = `${event.url.origin}/join/${encodeURIComponent(invite.token)}`;
	}

	return {
		campaign,
		...rosterView,
		eligibleAdventurers,
		activePlayerTenureId: activePlayerTenure?.id ?? null,
		inviteUrl,
		joinedWithoutAdventurer: event.url.searchParams.get('joined') === 'observer',
		cursor
	};
};

export const actions: Actions = {
	attach: async (event) => mutateAdventurer(event, 'attach'),
	replace: async (event) => mutateAdventurer(event, 'replace'),
	leave: async (event) => {
		const role = await requireRole(event, 'player');
		const result = await leaveCampaign(await getDb(event), {
			campaignId: event.params.id,
			membershipId: role.membershipId,
			userId: role.userId
		});
		if (!result.ok) return fail(409, { message: 'Campaign membership could not be changed.' });
		throw redirect(303, '/campaigns');
	},
	remove: async (event) => {
		const role = await requireRole(event, 'gm');
		const membershipId = requiredFormValue(await event.request.formData(), 'membershipId');
		const result = await removeCampaignMember(await getDb(event), {
			campaignId: event.params.id,
			membershipId,
			ownerUserId: role.userId
		});
		if (!result.ok) return fail(409, { message: 'That member could not be removed.' });
		return { success: 'member-removed' };
	},
	closeInvite: async (event) => {
		const role = await requireRole(event, 'gm');
		const result = await closeCampaignInvite(await getDb(event), {
			campaignId: event.params.id,
			ownerUserId: role.userId
		});
		if (!result.ok) throw error(404, 'Campaign not found');
		return { success: 'invite-closed' };
	},
	openInvite: async (event) => {
		const role = await requireRole(event, 'gm');
		const result = await openCampaignInvite(await getDb(event), {
			campaignId: event.params.id,
			ownerUserId: role.userId,
			secret: requireInviteSecret(event)
		});
		if (!result.ok) return fail(409, { message: 'The invitation could not be reopened.' });
		return { success: 'invite-opened' };
	},
	rotateInvite: async (event) => {
		const role = await requireRole(event, 'gm');
		const result = await rotateCampaignInvite(await getDb(event), {
			campaignId: event.params.id,
			ownerUserId: role.userId,
			secret: requireInviteSecret(event)
		});
		if (!result.ok) return fail(409, { message: 'The invitation could not be rotated.' });
		return { success: 'invite-rotated' };
	},
	archive: async (event) => {
		const role = await requireRole(event, 'gm');
		const result = await archiveCampaign(await getDb(event), {
			campaignId: event.params.id,
			ownerUserId: role.userId
		});
		if (!result.ok) return fail(409, { message: 'The campaign could not be archived.' });
		throw redirect(303, '/campaigns');
	}
};

async function mutateAdventurer(
	event: RequestEvent<{ id: string }>,
	action: 'attach' | 'replace'
) {
	const role = await requireRole(event, 'player');
	const characterId = requiredFormValue(await event.request.formData(), 'characterId');
	const service = action === 'replace' ? replaceAdventurer : attachAdventurer;
	const result = await service(await getDb(event), {
		campaignId: event.params.id,
		membershipId: role.membershipId,
		actorUserId: role.userId,
		characterId
	});
	if (!result.ok) {
		return fail(409, {
			message: action === 'replace' ? 'Adventurer could not be replaced.' : 'Adventurer could not be attached.'
		});
	}
	return { success: action === 'replace' ? 'adventurer-replaced' : 'adventurer-attached' };
}

async function requireRole<K extends CampaignRole['kind']>(
	event: RequestEvent<{ id: string }>,
	kind: K
): Promise<Extract<CampaignRole, { kind: K }>> {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== kind) throw error(404, 'Campaign not found');
	return role as Extract<CampaignRole, { kind: K }>;
}

function requiredFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	if (typeof value !== 'string' || !value.trim()) throw error(400, `Missing ${key}`);
	return value.trim();
}

function requireInviteSecret(event: RequestEvent): string {
	const secret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
	if (!secret) throw error(503, 'Campaign invitations are unavailable');
	return secret;
}
