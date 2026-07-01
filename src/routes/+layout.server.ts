import type { LayoutServerLoad } from './$types';

// Phase 2 extends this to surface the signed-in session to every page.
// Phase 0 keeps it minimal so the skeleton renders without auth wired up.
export const load: LayoutServerLoad = async () => {
	return {
		appVersion: __APP_VERSION__
	};
};
