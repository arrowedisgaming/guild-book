import { describe, expect, it } from 'vitest';
import { buildSnippet, markParts, splitSentences, splitSentencesFallback } from '$lib/search/snippets';

describe('splitSentences', () => {
	it('splits prose into sentences (Segmenter or fallback)', () => {
		const s = splitSentences('First rule. Second rule! Third?');
		expect(s).toEqual(['First rule.', 'Second rule!', 'Third?']);
	});

	it('the regex fallback splits the same prose (for engines without Intl.Segmenter)', () => {
		expect(splitSentencesFallback('First rule. Second rule! Third?')).toEqual([
			'First rule.',
			'Second rule!',
			'Third?'
		]);
	});
});

describe('markParts', () => {
	it('splits text into marked/unmarked parts for the matched terms', () => {
		expect(markParts('Draw a Challenge card.', ['challenge'])).toEqual([
			{ text: 'Draw a ', marked: false },
			{ text: 'Challenge', marked: true },
			{ text: ' card.', marked: false }
		]);
	});

	it('matches through curly apostrophes in the display text', () => {
		const parts = markParts('Death’s Door opens.', ['deaths']);
		expect(parts.find((p) => p.marked)?.text).toBe('Death’s');
	});

	it('merges overlapping term ranges instead of nesting marks', () => {
		const parts = markParts('challenge', ['challenge', 'chall']);
		expect(parts).toEqual([{ text: 'challenge', marked: true }]);
	});

	it('returns one unmarked part when nothing matches', () => {
		expect(markParts('No hits here.', ['zzz'])).toEqual([{ text: 'No hits here.', marked: false }]);
	});
});

describe('buildSnippet', () => {
	const body = 'Intro sentence with nothing. The Challenge Phase is played in rounds. Final sentence.';

	it('windows on the first sentence containing a matched term', () => {
		const parts = buildSnippet(body, ['challenge']);
		const text = parts.map((p) => p.text).join('');
		expect(text).toContain('Challenge Phase is played');
		expect(text).not.toContain('Intro sentence');
		expect(parts.some((p) => p.marked && /challenge/i.test(p.text))).toBe(true);
	});

	it('falls back to the body start when no term appears literally (fuzzy miss)', () => {
		const parts = buildSnippet(body, []);
		expect(parts.map((p) => p.text).join('')).toContain('Intro sentence');
	});
});
