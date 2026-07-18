import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyGuildRoster } from '$lib/server/campaign/service';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	getEnv: vi.fn(),
	requireCampaignFeature: vi.fn(),
	requireCampaignAccess: vi.fn(),
	createCampaign: vi.fn(),
	listCampaignsForUser: vi.fn(),
	loadCampaignProjection: vi.fn(),
	updateCampaignMetadata: vi.fn(),
	updateGuildRoster: vi.fn(),
	getCampaignInvite: vi.fn(),
	openCampaignInvite: vi.fn(),
	rotateCampaignInvite: vi.fn(),
	closeCampaignInvite: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/auth', () => ({ getEnv: mocks.getEnv }));
vi.mock('$lib/server/campaign/access', () => ({
	requireCampaignFeature: mocks.requireCampaignFeature,
	requireCampaignAccess: mocks.requireCampaignAccess,
	campaignHeaders: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' })
}));
vi.mock('$lib/server/campaign/service', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/campaign/service')>()),
	createCampaign: mocks.createCampaign,
	listCampaignsForUser: mocks.listCampaignsForUser,
	loadCampaignProjection: mocks.loadCampaignProjection,
	updateCampaignMetadata: mocks.updateCampaignMetadata,
	updateGuildRoster: mocks.updateGuildRoster,
	getCampaignInvite: mocks.getCampaignInvite,
	openCampaignInvite: mocks.openCampaignInvite,
	rotateCampaignInvite: mocks.rotateCampaignInvite,
	closeCampaignInvite: mocks.closeCampaignInvite
}));

import { GET as listCampaigns, POST as createCampaignRoute } from '../../src/routes/api/campaigns/+server';
import { GET as getCampaign, PATCH as patchCampaign } from '../../src/routes/api/campaigns/[id]/+server';
import { PUT as putRoster } from '../../src/routes/api/campaigns/[id]/roster/+server';
import {
	DELETE as closeInvite,
	GET as getInvite,
	PATCH as openInvite,
	POST as rotateInvite
} from '../../src/routes/api/campaigns/[id]/invite/+server';

describe('campaign HTTP contracts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getDb.mockResolvedValue({});
		mocks.getEnv.mockReturnValue('invite-secret');
		mocks.requireCampaignFeature.mockResolvedValue('owner-a');
		mocks.requireCampaignAccess.mockResolvedValue({
			kind: 'gm',
			userId: 'owner-a',
			campaignId: 'campaign-a'
		});
	});

	it('creates campaigns with 201 and hardened cache headers', async () => {
		mocks.createCampaign.mockResolvedValue({
			campaign: { id: 'campaign-a', role: 'gm' },
			roster: { version: 1, document: createEmptyGuildRoster('Guild') },
			inviteToken: 'signed-token'
		});
		const response = await createCampaignRoute(
			event({ method: 'POST', body: { name: 'Guild', description: '' } })
		);

		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('vary')).toBe('Cookie');
		expect(await response.json()).toMatchObject({ campaign: { id: 'campaign-a' } });
	});

	it('rejects invalid creation and lists only the service projection', async () => {
		await expect(
			createCampaignRoute(event({ method: 'POST', body: { name: '', description: '' } }))
		).rejects.toMatchObject({ status: 400 });

		mocks.listCampaignsForUser.mockResolvedValue([{ id: 'campaign-a', role: 'gm' }]);
		const response = await listCampaigns(event({ method: 'GET' }));
		expect(await response.json()).toEqual({ campaigns: [{ id: 'campaign-a', role: 'gm' }] });
	});

	it('maps owner metadata conflicts to 409 and hides player edits as 404', async () => {
		mocks.updateCampaignMetadata.mockResolvedValue({
			ok: false,
			reason: 'version-conflict',
			currentVersion: 2
		});
		const conflict = await patchCampaign(
			event({
				method: 'PATCH',
				params: { id: 'campaign-a' },
				body: { expectedVersion: 1, name: 'Renamed' }
			})
		);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ message: 'Campaign changed — refetch and retry', currentVersion: 2 });

		mocks.requireCampaignAccess.mockResolvedValue({
			kind: 'player',
			userId: 'player-a',
			campaignId: 'campaign-a',
			membershipId: 'membership-a'
		});
		await expect(
			patchCampaign(
				event({
					method: 'PATCH',
					params: { id: 'campaign-a' },
					body: { expectedVersion: 1, name: 'Denied' }
				})
			)
		).rejects.toMatchObject({ status: 404 });
	});

	it('validates and maps guarded roster updates', async () => {
		await expect(
			putRoster(
				event({
					method: 'PUT',
					params: { id: 'campaign-a' },
					body: { expectedVersion: 1, document: { ...createEmptyGuildRoster('Guild'), fame: -1 } }
				})
			)
		).rejects.toMatchObject({ status: 400 });

		mocks.updateGuildRoster.mockResolvedValue({ ok: true, version: 2 });
		const response = await putRoster(
			event({
				method: 'PUT',
				params: { id: 'campaign-a' },
				body: { expectedVersion: 1, document: createEmptyGuildRoster('Guild') }
			})
		);
		expect(await response.json()).toEqual({ success: true, version: 2 });
	});

	it('reproduces, closes, reopens, and rotates owner invitations', async () => {
		mocks.getCampaignInvite.mockResolvedValue({ ok: true, token: 'current-token', version: 1 });
		mocks.openCampaignInvite.mockResolvedValue({ ok: true, token: 'current-token', version: 1 });
		mocks.rotateCampaignInvite.mockResolvedValue({ ok: true, token: 'rotated-token', version: 2 });
		mocks.closeCampaignInvite.mockResolvedValue({ ok: true });

		const current = await getInvite(event({ method: 'GET', params: { id: 'campaign-a' } }));
		expect(await current.json()).toEqual({ token: 'current-token', version: 1 });
		const rotated = await rotateInvite(event({ method: 'POST', params: { id: 'campaign-a' } }));
		expect(await rotated.json()).toEqual({ token: 'rotated-token', version: 2 });
		const closed = await closeInvite(event({ method: 'DELETE', params: { id: 'campaign-a' } }));
		expect(await closed.json()).toEqual({ success: true });
		const opened = await openInvite(event({ method: 'PATCH', params: { id: 'campaign-a' } }));
		expect(await opened.json()).toEqual({ token: 'current-token', version: 1 });
	});

	it('returns the role-projected campaign read', async () => {
		mocks.loadCampaignProjection.mockResolvedValue({ id: 'campaign-a', role: 'gm' });
		const response = await getCampaign(event({ method: 'GET', params: { id: 'campaign-a' } }));
		expect(await response.json()).toEqual({ campaign: { id: 'campaign-a', role: 'gm' } });
	});
});

function event(input: {
	method: string;
	params?: { id: string };
	body?: unknown;
}) {
	return {
		request: new Request(`http://localhost/api/campaigns/${input.params?.id ?? ''}`, {
			method: input.method,
			headers: { 'Content-Type': 'application/json' },
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
		}),
		params: input.params ?? {},
		url: new URL(`http://localhost/api/campaigns/${input.params?.id ?? ''}`)
	} as never;
}
