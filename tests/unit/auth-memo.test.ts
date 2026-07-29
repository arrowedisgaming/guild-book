import { describe, expect, it, vi } from 'vitest';
import type { Handle } from '@sveltejs/kit';
import { memoiseAuthHandle } from '$lib/server/auth-memo';

/**
 * `@auth/sveltekit` installs `event.locals.auth` as a bare function
 * (`event.locals.auth ??= () => auth(event, _config)`), not a memoised promise,
 * so every call re-decodes the token and re-runs the `jwt` callback — including
 * its `users` read. The campaign path calls it at least twice per request (the
 * rate limiter, then `ensureUser`), spending a D1 round trip to re-derive a
 * value that cannot change within a single request.
 *
 * See "Memoise `locals.auth()` per request" in docs/operations/campaign-capacity.md.
 */

type TestLocals = {
	auth?: () => Promise<unknown>;
	getSession?: () => Promise<unknown>;
};

function runHandle(locals: TestLocals, body: () => Promise<void> | void) {
	const event = { locals } as unknown as Parameters<Handle>[0]['event'];
	return memoiseAuthHandle({
		event,
		resolve: async () => {
			await body();
			return new Response('ok');
		}
	} as unknown as Parameters<Handle>[0]);
}

describe('memoiseAuthHandle', () => {
	it('calls the underlying session resolver once across repeated calls', async () => {
		const session = { user: { id: 'user-a' } };
		const underlying = vi.fn(async () => session);
		const locals: TestLocals = { auth: underlying };

		await runHandle(locals, async () => {
			await locals.auth!();
			await locals.auth!();
			await locals.auth!();
		});

		expect(underlying).toHaveBeenCalledTimes(1);
	});

	it('returns the same session to every caller', async () => {
		const session = { user: { id: 'user-a' } };
		const locals: TestLocals = { auth: async () => session };

		const seen: unknown[] = [];
		await runHandle(locals, async () => {
			seen.push(await locals.auth!());
			seen.push(await locals.auth!());
		});

		expect(seen[0]).toBe(session);
		expect(seen[1]).toBe(session);
	});

	it('shares one in-flight resolution between concurrent callers', async () => {
		// The rate limiter and the route handler can both be waiting on this at
		// once; caching the promise rather than the result is what makes that a
		// single round trip instead of two racing ones.
		const underlying = vi.fn(
			() => new Promise((r) => setTimeout(() => r({ user: { id: 'user-a' } }), 5))
		);
		const locals: TestLocals = { auth: underlying as () => Promise<unknown> };

		await runHandle(locals, async () => {
			await Promise.all([locals.auth!(), locals.auth!(), locals.auth!()]);
		});

		expect(underlying).toHaveBeenCalledTimes(1);
	});

	it('memoises getSession, which Auth.js aliases to the same resolver', async () => {
		const underlying = vi.fn(async () => ({ user: { id: 'user-a' } }));
		const locals: TestLocals = { auth: underlying, getSession: underlying };

		await runHandle(locals, async () => {
			await locals.auth!();
			await locals.getSession!();
		});

		expect(underlying).toHaveBeenCalledTimes(1);
	});

	it('does not leak one request’s session into another', async () => {
		const first = vi.fn(async () => ({ user: { id: 'user-a' } }));
		const second = vi.fn(async () => ({ user: { id: 'user-b' } }));

		const localsA: TestLocals = { auth: first };
		const localsB: TestLocals = { auth: second };

		let a: unknown;
		let b: unknown;
		await runHandle(localsA, async () => {
			a = await localsA.auth!();
		});
		await runHandle(localsB, async () => {
			b = await localsB.auth!();
		});

		expect(a).toEqual({ user: { id: 'user-a' } });
		expect(b).toEqual({ user: { id: 'user-b' } });
	});

	it('propagates a rejection rather than swallowing it', async () => {
		// A failed session resolution must still fail the request. Caching the
		// rejected promise is deliberate: within one request the answer cannot
		// change, and retrying would spend the round trip this handle exists to
		// save.
		const underlying = vi.fn(async () => {
			throw new Error('token decode failed');
		});
		const locals: TestLocals = { auth: underlying };

		await expect(
			runHandle(locals, async () => {
				await locals.auth!();
			})
		).rejects.toThrow('token decode failed');
		expect(underlying).toHaveBeenCalledTimes(1);
	});

	it('is a no-op when no session resolver was installed', async () => {
		// During `building`, and on any path where the Auth.js handle has not run,
		// there is nothing to wrap. This must not throw.
		const locals: TestLocals = {};
		await expect(runHandle(locals, () => {})).resolves.toBeInstanceOf(Response);
	});
});
