import * as React from 'react';
import type { LocationDb } from '../storage/locationDb';
import type { Profile, SettingsDb } from '../storage/settingsDb';
import type { StackAction, StackState } from './screenStack';

/** What every screen can reach (REBUILD_PLAN §10). */
export interface AppServices {
	settings: SettingsDb;
	/** The selected location profile, or null when none is selected. */
	profile: Profile | null;
	/** The selected location's database (open, schema ensured), or null when no profile is selected. */
	locationDb: LocationDb | null;
	stack: StackState;
	navigate: (action: StackAction) => void;
	/** Back (header arrow, placeholder Back, Android Back): asks the screen's guard first, then pops. */
	goBack: () => void;
	/**
	 * A screen that must not be left silently (a running download) installs a guard; it returns
	 * true to allow leaving. Pass null to remove it.
	 */
	setBackGuard: (guard: (() => Promise<boolean>) | null) => void;
	/** Re-reads the selected profile and opens its location database if it changed. */
	reloadProfile: () => Promise<void>;
}

export const AppContext = React.createContext<AppServices | null>(null);

export function useApp(): AppServices {
	const app = React.useContext(AppContext);
	if (!app) throw new Error('useApp() outside AppContext');
	return app;
}
