// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { DefaultSession } from '@auth/core/types';
import type { AppDb } from '$lib/server/db';

declare module '@auth/core/types' {
	interface Session {
		user?: {
			id?: string;
		} & DefaultSession['user'];
	}
}

declare global {
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		interface Locals {
			db: AppDb;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB?: D1Database;
			};
		}
	}
}

export {};
