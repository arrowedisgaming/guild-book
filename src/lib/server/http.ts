import { error, type RequestEvent } from '@sveltejs/kit';

/**
 * Headers for any response that depends on the session cookie. Same contract
 * as the campaign feature's `campaignHeaders()`: never stored by a shared
 * cache, and keyed on the cookie by anything that stores it anyway.
 */
export function privateHeaders(): Record<string, string> {
	return { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
}

/**
 * Read and parse a JSON request body, refusing oversized payloads before
 * they are parsed. The limit is enforced on real bytes (Content-Length when
 * declared, then the decoded body), not on parsed-object size — a giant
 * unknown key must not ride in beside a small valid payload.
 */
export async function readBoundedJson(event: RequestEvent, maxBytes: number): Promise<unknown> {
	const declared = Number(event.request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw error(413, 'Request body is too large');
	}
	let text: string;
	try {
		text = await event.request.text();
	} catch {
		throw error(400, 'Could not read request body');
	}
	if (new TextEncoder().encode(text).length > maxBytes) {
		throw error(413, 'Request body is too large');
	}
	try {
		return JSON.parse(text);
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
