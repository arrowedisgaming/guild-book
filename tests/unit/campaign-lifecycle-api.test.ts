import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	getEnv: vi.fn(),
	requireCampaignFeature: vi.fn(),
	requireCampaignAccess: vi.fn(),
	joinCampaignWithInvite: vi.fn(),
	leaveCampaign: vi.fn(),
	removeCampaignMember: vi.fn(),
	archiveCampaign: vi.fn(),
	attachAdventurer: vi.fn(),
	replaceAdventurer: vi.fn(),
	markCharacterDead: vi.fn(),
	correctCharacterDeath: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/auth', () => ({ getEnv: mocks.getEnv }));
vi.mock('$lib/server/campaign/access', () => ({
	requireCampaignFeature: mocks.requireCampaignFeature,
	requireCampaignAccess: mocks.requireCampaignAccess,
	campaignHeaders: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' })
}));
vi.mock('$lib/server/campaign/membership', () => ({
	joinCampaignWithInvite: mocks.joinCampaignWithInvite,
	leaveCampaign: mocks.leaveCampaign,
	removeCampaignMember: mocks.removeCampaignMember,
	archiveCampaign: mocks.archiveCampaign
}));
vi.mock('$lib/server/campaign/tenure', () => ({
	attachAdventurer: mocks.attachAdventurer,
	replaceAdventurer: mocks.replaceAdventurer
}));
vi.mock('$lib/server/character/life', () => ({
	markCharacterDead: mocks.markCharacterDead,
	correctCharacterDeath: mocks.correctCharacterDeath
}));

import { POST as joinCampaign } from '../../src/routes/api/campaigns/join/[token]/+server';
import { DELETE as leaveCampaign } from '../../src/routes/api/campaigns/[id]/membership/+server';
import { POST as mutateAdventurer } from '../../src/routes/api/campaigns/[id]/adventurer/+server';
import { DELETE as removeMember } from '../../src/routes/api/campaigns/[id]/members/[membershipId]/+server';
import { PATCH as mutateLife } from '../../src/routes/api/characters/[id]/life/+server';
import { DELETE as archiveCampaign } from '../../src/routes/api/campaigns/[id]/+server';

describe('campaign lifecycle HTTP contracts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getDb.mockResolvedValue({});
		mocks.getEnv.mockReturnValue('invite-secret');
		mocks.requireCampaignFeature.mockResolvedValue('player-a');
		mocks.requireCampaignAccess.mockResolvedValue({
			kind: 'player',
			userId: 'player-a',
			campaignId: 'campaign-a',
			membershipId: 'membership-a'
		});
	});

	it('joins with an explicit mode and hides invalid invite details', async () => {
		mocks.joinCampaignWithInvite.mockResolvedValue({
			ok: true,
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			created: true,
			observer: true
		});
		const joined = await joinCampaign(
			event({ method: 'POST', token: 'signed-token', body: { joinWithoutCharacter: true } })
		);
		expect(joined.status).toBe(201);
		expect(joined.headers.get('cache-control')).toBe('private, no-store');

		mocks.joinCampaignWithInvite.mockResolvedValue({ ok: false, reason: 'invalid-invite' });
		await expect(
			joinCampaign(event({ method: 'POST', token: 'bad-token', body: { joinWithoutCharacter: true } }))
		).rejects.toMatchObject({ status: 404 });
	});

	it('maps player leave and adventurer replacement commands', async () => {
		mocks.leaveCampaign.mockResolvedValue({ ok: true, membershipId: 'membership-a' });
		const left = await leaveCampaign(event({ method: 'DELETE', id: 'campaign-a' }));
		expect(await left.json()).toEqual({ success: true, membershipId: 'membership-a' });

		mocks.replaceAdventurer.mockResolvedValue({
			ok: true,
			tenureId: 'tenure-b',
			replacedTenureId: 'tenure-a'
		});
		const replaced = await mutateAdventurer(
			event({
				method: 'POST',
				id: 'campaign-a',
				body: { action: 'replace', characterId: 'character-b' }
			})
		);
		expect(await replaced.json()).toMatchObject({ success: true, tenureId: 'tenure-b' });
	});

	it('keeps GM removal and archive owner-only and reports active-session conflict', async () => {
		mocks.requireCampaignAccess.mockResolvedValue({
			kind: 'gm',
			userId: 'owner-a',
			campaignId: 'campaign-a'
		});
		mocks.removeCampaignMember.mockResolvedValue({ ok: true, membershipId: 'membership-a' });
		const removed = await removeMember(
			event({ method: 'DELETE', id: 'campaign-a', membershipId: 'membership-a' })
		);
		expect(await removed.json()).toEqual({ success: true, membershipId: 'membership-a' });

		mocks.archiveCampaign.mockResolvedValue({ ok: false, reason: 'session-active' });
		const conflict = await archiveCampaign(event({ method: 'DELETE', id: 'campaign-a' }));
		expect(conflict.status).toBe(409);
	});

	it('maps versioned death and correction commands without exposing denials', async () => {
		mocks.markCharacterDead.mockResolvedValue({
			ok: false,
			reason: 'version-conflict',
			currentVersion: 2
		});
		const conflict = await mutateLife(
			event({
				method: 'PATCH',
				id: 'character-a',
				body: { action: 'mark-dead', expectedVersion: 1, campaignId: 'campaign-a' }
			})
		);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ currentVersion: 2 });

		mocks.correctCharacterDeath.mockResolvedValue({ ok: false, reason: 'not-found' });
		await expect(
			mutateLife(
				event({
					method: 'PATCH',
					id: 'character-a',
					body: { action: 'correct-death', expectedVersion: 2 }
				})
			)
		).rejects.toMatchObject({ status: 404 });
	});
});

function event(input: {
	method: string;
	id?: string;
	token?: string;
	membershipId?: string;
	body?: unknown;
}) {
	return {
		request: new Request('http://localhost/api/campaigns', {
			method: input.method,
			headers: { 'Content-Type': 'application/json' },
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
		}),
		params: {
			...(input.id ? { id: input.id } : {}),
			...(input.token ? { token: input.token } : {}),
			...(input.membershipId ? { membershipId: input.membershipId } : {})
		},
		url: new URL('http://localhost/api/campaigns')
	} as never;
}
