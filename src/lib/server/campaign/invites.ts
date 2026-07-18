interface InviteClaims {
	tokenVersion: 1;
	campaignId: string;
	inviteVersion: number;
	nonce: string;
}

export interface VerifiedInviteClaims {
	campaignId: string;
	version: number;
	nonce: string;
}

export interface InviteTokenStorage {
	inviteTokenPrefix: string;
	inviteTokenHash: string;
	inviteNonce: string;
	inviteVersion: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Issue a reproducible signed token from persisted campaign invite inputs. */
export async function issueInviteToken(input: {
	campaignId: string;
	version: number;
	nonce: string;
	secret: string;
}): Promise<string> {
	const claims: InviteClaims = {
		tokenVersion: 1,
		campaignId: input.campaignId,
		inviteVersion: input.version,
		nonce: input.nonce
	};
	const payload = base64UrlEncode(textEncoder.encode(JSON.stringify(claims)));
	const signature = await crypto.subtle.sign(
		'HMAC',
		await importHmacKey(input.secret, ['sign']),
		textEncoder.encode(payload)
	);

	return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify the MAC in constant time through Web Crypto, then validate the claims. */
export async function verifyInviteToken(
	token: string,
	secret: string
): Promise<VerifiedInviteClaims | null> {
	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

	try {
		const payloadBytes = base64UrlDecode(parts[0]);
		const signature = base64UrlDecode(parts[1]);
		const valid = await crypto.subtle.verify(
			'HMAC',
			await importHmacKey(secret, ['verify']),
			signature,
			textEncoder.encode(parts[0])
		);
		if (!valid) return null;

		const claims: unknown = JSON.parse(textDecoder.decode(payloadBytes));
		if (!isInviteClaims(claims)) return null;
		return {
			campaignId: claims.campaignId,
			version: claims.inviteVersion,
			nonce: claims.nonce
		};
	} catch {
		return null;
	}
}

/** Derive the only invite token material permitted in campaign persistence. */
export async function inviteTokenStorage(
	token: string,
	nonce: string,
	version: number
): Promise<InviteTokenStorage> {
	const inviteTokenHash = await sha256Hex(token);
	return {
		inviteTokenPrefix: inviteTokenHash.slice(0, 16),
		inviteTokenHash,
		inviteNonce: nonce,
		inviteVersion: version
	};
}

/** Generate a nondeterministic 128-bit nonce encoded as lowercase hex. */
export function createInviteNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return bytesToHex(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
	return bytesToHex(new Uint8Array(digest));
}

function isInviteClaims(value: unknown): value is InviteClaims {
	if (!value || typeof value !== 'object') return false;
	const claims = value as Record<string, unknown>;
	return (
		claims.tokenVersion === 1 &&
		typeof claims.campaignId === 'string' &&
		claims.campaignId.length > 0 &&
		Number.isInteger(claims.inviteVersion) &&
		(claims.inviteVersion as number) > 0 &&
		typeof claims.nonce === 'string' &&
		/^[0-9a-f]{32}$/.test(claims.nonce)
	);
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		textEncoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		usages
	);
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid base64url');
	const padding = '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
