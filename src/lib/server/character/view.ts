/**
 * Server wrapper around the browser-safe character view builder. The owner
 * sheet and public share page use this convenience entry point; the anonymous
 * wizard passes its already-loaded content to the pure builder directly.
 */

import type { GuildBookCharacterData } from '$lib/types/character';
import type { CharacterView } from '$lib/types/character-view';
import { buildCharacterViewFromContent } from '$lib/character/view';
import { loadWizardData } from '$lib/server/content/loader';

export type { CharacterView };

export function buildCharacterView(char: GuildBookCharacterData): CharacterView {
	return buildCharacterViewFromContent(char, loadWizardData());
}
