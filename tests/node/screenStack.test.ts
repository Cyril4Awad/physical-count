import { describe, expect, it } from 'vitest';
import { canGoBack, currentRoute, initialStack, screenStackReducer, StackAction, StackState } from '../../src/shell/screenStack';

const run = (...actions: StackAction[]): StackState => actions.reduce(screenStackReducer, initialStack);

describe('screen stack', () => {
	it('starts on Home, where Back leaves the app', () => {
		expect(currentRoute(initialStack)).toEqual({ name: 'home' });
		expect(canGoBack(initialStack)).toBe(false);
	});

	it('pushes and pops', () => {
		const state = run({ type: 'push', route: { name: 'items', tab: 'counted' } }, { type: 'push', route: { name: 'scan', lineId: '47842' } });
		expect(state.routes.map((r) => r.name)).toEqual(['home', 'items', 'scan']);
		expect(currentRoute(state)).toEqual({ name: 'scan', lineId: '47842' });
		expect(currentRoute(screenStackReducer(state, { type: 'pop' }))).toEqual({ name: 'items', tab: 'counted' });
	});

	it('keeps Home when popping at the root (same state object)', () => {
		expect(screenStackReducer(initialStack, { type: 'pop' })).toBe(initialStack);
	});

	it('ignores a double tap that pushes the same route twice', () => {
		const once = run({ type: 'push', route: { name: 'settings' } });
		expect(screenStackReducer(once, { type: 'push', route: { name: 'settings' } })).toBe(once);
	});

	it('pushes the same screen with different params', () => {
		const state = run({ type: 'push', route: { name: 'items', tab: 'counted' } }, { type: 'push', route: { name: 'items', tab: 'notCounted' } });
		expect(state.routes).toHaveLength(3);
	});

	it('Items remembers its tab and scroll position under Scan, and Back returns to them', () => {
		const state = run(
			{ type: 'push', route: { name: 'items', tab: 'notCounted' } },
			// What Items does when a row is tapped: note where it is, then open the line.
			{ type: 'replace', route: { name: 'items', tab: 'counted', position: { index: 4321, offset: -17 } } },
			{ type: 'push', route: { name: 'scan', lineId: '47842' } },
		);
		expect(state.routes.map((r) => r.name)).toEqual(['home', 'items', 'scan']);
		expect(currentRoute(screenStackReducer(state, { type: 'pop' }))).toEqual({ name: 'items', tab: 'counted', position: { index: 4321, offset: -17 } });
	});

	it('replaces the top screen', () => {
		const state = run({ type: 'push', route: { name: 'download' } }, { type: 'replace', route: { name: 'upload' } });
		expect(state.routes.map((r) => r.name)).toEqual(['home', 'upload']);
	});

	it('never replaces Home with another screen', () => {
		expect(run({ type: 'replace', route: { name: 'scan' } }).routes).toEqual([{ name: 'home' }]);
	});

	it('pushing Home goes back to Home only', () => {
		const state = run({ type: 'push', route: { name: 'download' } }, { type: 'push', route: { name: 'home' } });
		expect(state.routes).toEqual([{ name: 'home' }]);
	});

	it('resets to Home after a completed download', () => {
		const state = run({ type: 'push', route: { name: 'download' } }, { type: 'reset' });
		expect(state.routes).toEqual([{ name: 'home' }]);
		expect(screenStackReducer(initialStack, { type: 'reset' })).toBe(initialStack);
	});

	it('does not mutate earlier states', () => {
		const one = run({ type: 'push', route: { name: 'settings' } });
		const snapshot = JSON.stringify(one);
		screenStackReducer(one, { type: 'push', route: { name: 'upload' } });
		screenStackReducer(one, { type: 'pop' });
		expect(JSON.stringify(one)).toBe(snapshot);
	});
});
