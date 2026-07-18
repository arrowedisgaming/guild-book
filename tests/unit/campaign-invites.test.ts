import { describe, expect, it } from 'vitest';
import {
	createInviteNonce,
	inviteTokenStorage,
	issueInviteToken,
	verifyInviteToken
} from '$lib/server/campaign/invites';

const SECRET = 'dedicated-test-secret';
const NONCE = '0123456789abcdef0123456789abcdef';

describe('campaign invitation tokens', () => {
	it('round-trips signed versioned claims without exposing the secret', async () => {
		const token = await issueInviteToken({
			campaignId: 'campaign-a',
			version: 2,
			nonce: NONCE,
			secret: SECRET
		});

		expect(token).not.toContain(SECRET);
		await expect(verifyInviteToken(token, SECRET)).resolves.toEqual({
			campaignId: 'campaign-a',
			version: 2,
			nonce: NONCE
		});
	});

	it('rejects tampering, wrong secrets, and malformed token payloads', async () => {
		const token = await issueInviteToken({
			campaignId: 'campaign-a',
			version: 2,
			nonce: NONCE,
			secret: SECRET
		});

		await expect(verifyInviteToken(`${token}x`, SECRET)).resolves.toBeNull();
		await expect(verifyInviteToken(token, 'wrong-secret')).resolves.toBeNull();
		await expect(verifyInviteToken('not.a.valid.token', SECRET)).resolves.toBeNull();
	});

	it('derives only lookup-safe persisted metadata from a raw token', async () => {
		const token = await issueInviteToken({
			campaignId: 'campaign-a',
			version: 2,
			nonce: NONCE,
			secret: SECRET
		});
		const storage = await inviteTokenStorage(token, NONCE, 2);

		expect(storage).toMatchObject({ inviteNonce: NONCE, inviteVersion: 2 });
		expect(storage.inviteTokenPrefix).toHaveLength(16);
		expect(storage.inviteTokenHash).toHaveLength(64);
		expect(JSON.stringify(storage)).not.toContain(token);
		expect(JSON.stringify(storage)).not.toContain(SECRET);
	});

	it('generates fresh 128-bit nonces for production invitations', () => {
		const first = createInviteNonce();
		const second = createInviteNonce();

		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).toMatch(/^[0-9a-f]{32}$/);
		expect(second).not.toBe(first);
	});
});
