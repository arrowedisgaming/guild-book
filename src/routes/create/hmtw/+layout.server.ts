import type { LayoutServerLoad } from './$types';
import { loadWizardData } from '$lib/server/content/loader';

// All content the wizard steps need, validated once and merged into every
// step page's `data` prop.
export const load: LayoutServerLoad = async () => {
	return loadWizardData();
};
