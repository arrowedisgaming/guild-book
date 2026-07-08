/**
 * Ability names are displayed with a trailing period ("Fleet."), but some book
 * names carry their own punctuation ("Sorrow! Sorrow! Sorrow!", "Do You Doubt
 * Me, Traitor?") — don't double it.
 */
export function abilityLabel(name: string): string {
	return /[.!?…]$/.test(name) ? name : `${name}.`;
}
