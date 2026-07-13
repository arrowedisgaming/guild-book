import { describe, it, expect } from 'vitest';
import {
	dropLastSentence,
	paragraphizeSentences,
	shortenedIntroduction,
	truncateAtSentence
} from '$lib/utils/text';

describe('truncateAtSentence', () => {
	it('returns short text unchanged', () => {
		expect(truncateAtSentence('One. Two.', 100)).toBe('One. Two.');
	});

	it('cuts at the first sentence boundary past the budget', () => {
		const text = 'a a a a a. b b b b b. c c c c c.';
		// budget 6 words → keep growing to the sentence end after word 6
		expect(truncateAtSentence(text, 6)).toBe('a a a a a. b b b b b.');
	});

	it('keeps whole sentences, never a partial one', () => {
		const text = 'First sentence here. Second one is a bit longer than the first. Third.';
		const out = truncateAtSentence(text, 5);
		expect(out).toBe('First sentence here. Second one is a bit longer than the first.');
		expect(out.endsWith('.')).toBe(true);
	});

	it('hard-cuts with an ellipsis when no sentence end is reachable', () => {
		const text = 'word '.repeat(200).trim(); // no punctuation at all
		const out = truncateAtSentence(text, 10);
		expect(out.endsWith('…')).toBe(true);
		expect(out.split(/\s+/).length).toBeLessThanOrEqual(11);
	});
});

describe('dropLastSentence', () => {
	it('removes exactly the final complete sentence', () => {
		expect(dropLastSentence('One. Two! Three?')).toBe('One. Two!');
	});

	it('keeps a single-sentence excerpt visible', () => {
		expect(dropLastSentence('Only one.')).toBe('Only one.');
	});
});

describe('shortenedIntroduction', () => {
	it('uses only the first paragraph and removes exactly its final sentence', () => {
		expect(shortenedIntroduction('First. Second. Third.\n\nFull lore remains elsewhere.')).toBe(
			'First. Second.'
		);
	});
});

describe('paragraphizeSentences', () => {
	it('groups sentences without changing their text', () => {
		const text = 'One. Two! Three? Four.';
		const formatted = paragraphizeSentences(text, 2);
		expect(formatted).toBe('One. Two!\n\nThree? Four.');
		expect(formatted.replace(/\n{2,}/g, ' ')).toBe(text);
	});

	it('retains existing markdown paragraphs', () => {
		expect(paragraphizeSentences('One.\n\nTwo.', 2)).toBe('One.\n\nTwo.');
	});
});
