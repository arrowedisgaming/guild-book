/**
 * Server-side "can this denizen actually be saved?" check. Template ids are
 * validated against the loader — never trusted from the client — and the
 * stat invariants are the engine's own draftStatWarnings, so the API rejects
 * exactly the drafts the builder warns about.
 */

import type { DenizenDraft } from '$lib/engine/denizen-builder';
import { draftStatWarnings } from '$lib/engine/denizen-builder';
import {
	getDenizenPersonRules,
	getDenizenThemes,
	getDenizenThreats
} from '$lib/server/content/loader';

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateSavedDenizen(draft: DenizenDraft): ValidationResult {
	const errors: string[] = [];

	const theme = getDenizenThemes().find((t) => t.id === draft.themeId);
	if (!theme) {
		errors.push('Choose a theme.');
	} else if (draft.kind === 'person') {
		// "Person-kind allowed no threat id" is a server-side rule: the theme
		// itself must be person-mode per the loader, not a client flag.
		if (theme.builderMode !== 'person') {
			errors.push('Only a person-mode theme can save a person.');
		}
		if (draft.threatId !== null) {
			errors.push('A person has no threat template.');
		}
	} else {
		if (theme.builderMode === 'unsupported') {
			errors.push('That theme is reference-only.');
		}
		const threat = getDenizenThreats().find((t) => t.id === draft.threatId);
		if (!threat) {
			errors.push('Choose a threat.');
		} else if (threat.builderMode === 'unsupported') {
			errors.push('That threat is reference-only.');
		}
	}

	const threat = getDenizenThreats().find((t) => t.id === draft.threatId) ?? null;
	errors.push(...draftStatWarnings(draft, threat, getDenizenPersonRules()));

	return { valid: errors.length === 0, errors };
}
