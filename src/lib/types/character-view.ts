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
	talents: { name: string; state: string; wounded: boolean; xp: number }[];
	motifs: string[];
	bonds: { targetName: string; text: string; charged: boolean }[];
	equipment: {
		name: string;
		tier: string;
		location: string;
		quantity: number;
		slots: number;
		notchesTaken: number;
		durability: number | null;
		destroyed: boolean;
	}[];
	load: {
		hands: { used: number; capacity: number; over: boolean };
		belt: { used: number; capacity: number; over: boolean };
		pack: { used: number; capacity: number; over: boolean };
	};
	conditions: { id: string; name: string; description: string }[];
	afflictions: { name: string; stage: number; stageCount: number; effect: string }[];
	resolve: { current: number; max: number };
	lore: number;
	languages: string[];
}
