import { describe, expect, it } from 'vitest';
import { sessionCommandSchema } from '$lib/schemas/session.schema';

/**
 * Command schemas are the browser-facing trust boundary: every attacker-
 * controllable number/array must have an upper bound, not just a lower one.
 * The deck has 78 cards, so 78 is the natural ceiling for any count or
 * card-id array.
 */
describe('session command schema bounds', () => {
	it('rejects an absurd draw count', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'draw',
			deck: 'major',
			destinationZoneId: 'zone-1',
			count: 999_999
		});
		expect(result.success).toBe(false);
	});

	it('accepts a draw count at the 78-card ceiling', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'draw',
			deck: 'major',
			destinationZoneId: 'zone-1',
			count: 78
		});
		expect(result.success).toBe(true);
	});

	it('rejects an absurd deal countPerDestination', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'deal',
			deck: 'player',
			destinationZoneIds: ['zone-1'],
			countPerDestination: 999_999
		});
		expect(result.success).toBe(false);
	});

	it('rejects an oversized deal destinationZoneIds array', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'deal',
			deck: 'player',
			destinationZoneIds: Array.from({ length: 21 }, (_, index) => `zone-${index}`),
			countPerDestination: 1
		});
		expect(result.success).toBe(false);
	});

	it('rejects an oversized reorder-top cardIds array', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'reorder-top',
			zoneId: 'zone-1',
			cardIds: Array.from({ length: 79 }, (_, index) => `card-${index}`)
		});
		expect(result.success).toBe(false);
	});

	it('accepts a reorder-top cardIds array at the 78-card ceiling', () => {
		const result = sessionCommandSchema.safeParse({
			type: 'reorder-top',
			zoneId: 'zone-1',
			cardIds: Array.from({ length: 78 }, (_, index) => `card-${index}`)
		});
		expect(result.success).toBe(true);
	});
});
