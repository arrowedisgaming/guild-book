import { expect, it } from 'vitest';
import { createBlankCharacter } from '$lib/types/character';
import { buildCharacterViewFromContent } from '$lib/character/view';
import { loadWizardData } from '$lib/server/content/loader';

it('projects XP and component details without leaking private ledger reasons', () => {
 const char = createBlankCharacter();
 char.experience = 3;
 char.xpLedger.entries = [{ id: 'award', at: '2026-09-09T12:00:00Z', delta: 3, kind: 'award', sourceId: 'quest-accepted', sourceLabel: 'Quest accepted', reason: 'Secret quest plan' }];
 char.equipment.push({ itemId: null, customName: 'Chapel ash', tier: 'impoverished', packSpace: 1, location: 'pack', quantity: 2, notchesTaken: 0, spellComponent: { spellId: 'missing-spell', spellName: 'Forgotten ward', notes: 'Stored in red pouch' } });
 const view = buildCharacterViewFromContent(char, loadWizardData());
 expect(view.experience).toBe(3);
 expect(JSON.stringify(view)).not.toContain('Secret quest plan');
 expect(JSON.stringify(view)).not.toContain('xpLedger');
 expect(view.equipment).toHaveLength(1);
 expect(view.equipment[0].spellComponent?.spellName).toBe('Forgotten ward');
 expect(view.load.pack.used).toBe(2);
});
