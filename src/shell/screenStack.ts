/**
 * The app's screen stack (REBUILD_PLAN §10): a plain reducer, no navigation
 * library. Only the top route is rendered; Home is always at the bottom.
 * Pure module: no NativeScript or React imports.
 */
import type { ItemsTab } from '../domain/itemText';

export type { ItemsTab };

/** Where a list was scrolled to: the first visible row and how far (px, ≤ 0) its top is above the list's top. */
export interface ListPosition {
	index: number;
	offset: number;
}

export type Route =
	| { name: 'home' }
	| { name: 'settings' }
	| { name: 'download' }
	| { name: 'upload' }
	/** `position`: written by Items just before it opens a line in Scan, so Back returns to the same place. */
	| { name: 'items'; tab: ItemsTab; position?: ListPosition }
	/** Without `lineId`: counting mode. With `lineId` (opened from Items): display only. */
	| { name: 'scan'; lineId?: string };

export interface StackState {
	routes: readonly Route[];
}

export type StackAction =
	| { type: 'push'; route: Route }
	| { type: 'pop' }
	| { type: 'replace'; route: Route }
	/** Back to Home only, e.g. after a completed download. */
	| { type: 'reset' };

const HOME: Route = { name: 'home' };

export const initialStack: StackState = { routes: [HOME] };

function sameRoute(a: Route, b: Route): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function screenStackReducer(state: StackState, action: StackAction): StackState {
	const { routes } = state;
	const top = routes[routes.length - 1];
	switch (action.type) {
		case 'push':
			if (action.route.name === 'home') return { routes: [HOME] };
			// A double tap must not open the same screen twice.
			if (sameRoute(top, action.route)) return state;
			return { routes: [...routes, action.route] };
		case 'pop':
			return routes.length > 1 ? { routes: routes.slice(0, -1) } : state;
		case 'replace':
			if (routes.length === 1 || action.route.name === 'home') return { routes: [HOME] };
			return { routes: [...routes.slice(0, -1), action.route] };
		case 'reset':
			return routes.length === 1 ? state : { routes: [HOME] };
	}
}

export function currentRoute(state: StackState): Route {
	return state.routes[state.routes.length - 1];
}

/** False on Home: Back then leaves the app, as Android expects. */
export function canGoBack(state: StackState): boolean {
	return state.routes.length > 1;
}
