/**
 * Return a response whose headers can be written to.
 *
 * `Response.redirect()` and `fetch()` results carry immutable headers, and
 * setting one throws `TypeError: Can't modify immutable headers`. Auth.js
 * answers every failed sign-in with `Response.redirect(...)`, so the server
 * hook must not assume the response it gets back from `resolve` is writable.
 */
export function withMutableHeaders(response: Response): Response {
	try {
		// Deleting an absent header changes nothing on a writable response and
		// throws on an immutable one — the runtime exposes no flag to read instead.
		response.headers.delete('x-guildbook-mutability-probe');
		return response;
	} catch {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers)
		});
	}
}
