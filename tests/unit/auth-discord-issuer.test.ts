import { describe, expect, it } from 'vitest';
import { Auth, customFetch, skipCSRFCheck, type AuthConfig } from '@auth/core';
import { discordProvider } from '../../src/lib/server/auth-policy';

const ORIGIN = 'https://guildbook.test';

function cookiePairs(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((value) => value.split(';', 1)[0])
		.join('; ');
}

describe('Discord sign-in callback', () => {
	it('accepts the `iss` parameter Discord adds to its authorization response', async () => {
		// Discord began returning `iss=https://discord.com` on the callback (RFC
		// 9207). Auth.js validates that against the provider's issuer, and with
		// none configured it expects its placeholder "https://authjs.dev" — so
		// every Discord sign-in was rejected until the issuer was declared.
		const errors: unknown[] = [];
		const provider = discordProvider({ clientId: 'discord-client', clientSecret: 'discord-secret' });
		const discordApi = async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes('/oauth2/token')) {
				return Response.json({ access_token: 'access', token_type: 'Bearer' });
			}
			return Response.json({
				id: '80351110224678912',
				username: 'adventurer',
				global_name: 'Adventurer',
				discriminator: '0',
				avatar: null,
				email: 'adventurer@example.com',
				verified: true
			});
		};
		provider.options = { ...provider.options, [customFetch]: discordApi };

		const config: AuthConfig = {
			providers: [provider],
			secret: 'test-secret-test-secret-test-secret',
			session: { strategy: 'jwt' },
			skipCSRFCheck,
			trustHost: true,
			logger: { error: (error) => errors.push(error), warn() {}, debug() {} }
		};

		const signIn = await Auth(
			new Request(`${ORIGIN}/auth/signin/discord`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ callbackUrl: `${ORIGIN}/characters` })
			}),
			config
		);
		expect(signIn.status).toBe(302);

		const callback = await Auth(
			new Request(
				`${ORIGIN}/auth/callback/discord?code=test-code&iss=${encodeURIComponent('https://discord.com')}`,
				{ headers: { cookie: cookiePairs(signIn) } }
			),
			config
		);

		expect(errors).toEqual([]);
		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe(`${ORIGIN}/characters`);
	});
});
