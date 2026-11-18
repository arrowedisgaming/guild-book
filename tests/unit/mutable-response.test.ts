import { describe, expect, it } from 'vitest';
import { withMutableHeaders } from '../../src/lib/server/mutable-response';

describe('withMutableHeaders', () => {
	it('lets headers be set on a Response.redirect, which Auth.js returns for failed sign-ins', () => {
		// Auth.js answers a failed OAuth callback with `Response.redirect(...)`.
		// Its headers are immutable, so the security-header pass in the server hook
		// threw and turned every sign-in error into a 500.
		const redirect = Response.redirect('https://example.test/login?error=OAuthAccountNotLinked');
		expect(() => redirect.headers.set('X-Frame-Options', 'DENY')).toThrow();

		const response = withMutableHeaders(redirect);
		response.headers.set('X-Frame-Options', 'DENY');

		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe(
			'https://example.test/login?error=OAuthAccountNotLinked'
		);
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
	});

	it('returns an ordinary response untouched', () => {
		const ordinary = new Response('ok', { headers: { 'Set-Cookie': 'a=1' } });
		expect(withMutableHeaders(ordinary)).toBe(ordinary);
	});
});
