import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	ensureUser: vi.fn(),
	getDb: vi.fn(),
	previewCampaignInvite: vi.fn(),
	joinCampaignWithInvite: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({
	ensureUser: mocks.ensureUser,
	getEnv: (event: { platform?: { env?: Record<string, string> } }, key: string) =>
		event.platform?.env?.[key]
}));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/campaign/membership', () => ({
	previewCampaignInvite: mocks.previewCampaignInvite,
	joinCampaignWithInvite: mocks.joinCampaignWithInvite
}));

import { load as loadInvitation } from '../../src/routes/join/[token]/+page.server';

describe('campaign invitation page', () => {
	it('sets private headers before redirecting an unauthenticated visitor to sign in', async () => {
		const setHeaders = vi.fn();
		await expect(
			loadInvitation(
				event({
					auth: async () => null,
					setHeaders
				})
			)
		).rejects.toMatchObject({ status: 302, location: '/login?callbackUrl=%2Fjoin%2Ftoken-a' });
		expect(setHeaders).toHaveBeenCalledWith({
			'Cache-Control': 'private, no-store',
			Vary: 'Cookie'
		});
	});

	it('returns a real 404 for an invalid invitation without joining on GET', async () => {
		mocks.ensureUser.mockResolvedValue('player-a');
		mocks.previewCampaignInvite.mockResolvedValue(null);
		await expect(loadInvitation(event())).rejects.toMatchObject({
			status: 404,
			body: { message: 'This invitation is no longer available.' }
		});
		expect(mocks.joinCampaignWithInvite).not.toHaveBeenCalled();
	});

	it('returns the minimal campaign preview without joining', async () => {
		mocks.ensureUser.mockResolvedValue('player-a');
		mocks.previewCampaignInvite.mockResolvedValue({
			campaignId: 'campaign-a',
			name: 'The Lantern Guild'
		});
		await expect(loadInvitation(event())).resolves.toEqual({
			invitation: { campaignId: 'campaign-a', name: 'The Lantern Guild' }
		});
		expect(mocks.joinCampaignWithInvite).not.toHaveBeenCalled();
	});
});

function event(
	overrides: {
		auth?: () => Promise<{ user: { id: string } } | null>;
		setHeaders?: (headers: Record<string, string>) => void;
	} = {}
) {
	return {
		locals: { auth: overrides.auth ?? (async () => ({ user: { id: 'player-a' } })) },
		platform: {
			env: {
				CAMPAIGNS_ENABLED: 'true',
				CAMPAIGN_INVITE_SECRET: 'invite-secret'
			}
		},
		params: { token: 'token-a' },
		url: new URL('http://localhost/join/token-a'),
		setHeaders: overrides.setHeaders ?? vi.fn()
	} as never;
}
