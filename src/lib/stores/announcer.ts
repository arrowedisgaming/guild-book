/** Tiny live-region announcer for screen readers. */
import { writable } from 'svelte/store';

export const announcement = writable('');

export function announce(message: string): void {
	// Clear then set so repeated identical messages are re-announced.
	announcement.set('');
	setTimeout(() => announcement.set(message), 30);
}
