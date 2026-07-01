/**
 * Display-ready adventurer view — content-pack ids resolved to names. Built
 * server-side (see `$lib/server/character/view.ts`) and consumed by the sheet,
 * the public share page, and the client-side PDF/Markdown exporters. Lives in
 * `types/` (not `server/`) so client export code can import it without pulling
 * in server-only modules.
 */
export interface CharacterView {
	name: string;
	pronouns: string;
	appearance: string;
	quest: string;
	notes: string;
	kith: string | null;
	kin: string | null;
	path: string | null;
	attributes: { id: string; name: string; value: number }[];
	talents: { name: string; state: string }[];
	motifs: string[];
	bonds: { targetName: string; text: string }[];
	equipment: { name: string; tier: string }[];
	resolve: { current: number; max: number };
	languages: string[];
	conditions: string[];
}
