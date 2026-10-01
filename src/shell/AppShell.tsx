import { AndroidActivityBackPressedEventData, Application, Dialogs, isAndroid, Utils } from '@nativescript/core';
import * as React from 'react';
import { DOWNLOAD_BACKGROUND_THREAD } from '../config';
import { DownloadScreen } from '../screens/DownloadScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { ItemsScreen } from '../screens/ItemsScreen';
import { ScanScreen } from '../screens/ScanScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { UploadScreen } from '../screens/UploadScreen';
import { LocationDb, locationDbFileName } from '../storage/locationDb';
import { Profile, SettingsDb } from '../storage/settingsDb';
import { AppContext, AppServices } from './AppContext';
import { canGoBack, currentRoute, initialStack, Route, screenStackReducer } from './screenStack';

/**
 * App shell (REBUILD_PLAN §10): one Frame, one Page with the action bar hidden,
 * the screen stack from step 2, Back handling (§9.4) and the open databases.
 * Only the top screen is rendered; screens reload their data when they mount.
 */

function Screen({ route }: { route: Route }) {
	switch (route.name) {
		case 'home':
			return <HomeScreen />;
		case 'settings':
			return <SettingsScreen />;
		case 'scan':
			return <ScanScreen key={route.lineId ?? 'count'} lineId={route.lineId} />;
		case 'items':
			return <ItemsScreen tab={route.tab} position={route.position} />;
		case 'download':
			return <DownloadScreen />;
		case 'upload':
			return <UploadScreen />;
	}
}

async function openLocation(profile: Profile | null): Promise<LocationDb | null> {
	if (!profile) return null;
	const db = LocationDb.open(locationDbFileName(profile.location), { threading: DOWNLOAD_BACKGROUND_THREAD });
	await db.ensureSchema();
	return db;
}

export function AppShell() {
	const [stack, dispatch] = React.useReducer(screenStackReducer, initialStack);
	const [settings, setSettings] = React.useState<SettingsDb | null>(null);
	const [profile, setProfile] = React.useState<Profile | null>(null);
	const [locationDb, setLocationDb] = React.useState<LocationDb | null>(null);
	const [startupError, setStartupError] = React.useState<string | null>(null);

	// Refs so the Back listener (registered once) and reloadProfile see current values.
	const stackRef = React.useRef(stack);
	stackRef.current = stack;
	const locationRef = React.useRef<{ location: string | null; db: LocationDb | null }>({ location: null, db: null });
	const backGuardRef = React.useRef<(() => Promise<boolean>) | null>(null);

	const goBack = React.useCallback(() => {
		const guard = backGuardRef.current;
		if (!guard) return dispatch({ type: 'pop' });
		void guard().then((allowed) => allowed && dispatch({ type: 'pop' }));
	}, []);

	const applyProfile = React.useCallback(async (db: SettingsDb) => {
		const selected = await db.selectedProfile();
		const current = locationRef.current;
		if ((selected?.location ?? null) !== current.location) {
			current.db?.close();
			const opened = await openLocation(selected);
			locationRef.current = { location: selected?.location ?? null, db: opened };
			setLocationDb(opened);
		}
		setProfile(selected);
	}, []);

	React.useEffect(() => {
		(async () => {
			try {
				const db = await SettingsDb.open();
				await applyProfile(db);
				setSettings(db);
			} catch (error) {
				setStartupError(String(error));
			}
		})();
	}, [applyProfile]);

	// Android Back (§9.4): pop the app's stack. On Home, move the app to the
	// background instead of letting Android finish the activity: react-nativescript's
	// start() renders the root once, so a recreated activity would show a blank page.
	React.useEffect(() => {
		if (!isAndroid) return;
		const onBack = (args: AndroidActivityBackPressedEventData) => {
			console.log(`[shell] activityBackPressed (stack depth ${stackRef.current.routes.length})`);
			args.cancel = true;
			if (backGuardRef.current || canGoBack(stackRef.current)) goBack();
			else Utils.android.getCurrentActivity()?.moveTaskToBack(true);
		};
		// Lifecycle log, to check activity recreation (dark mode, font size, low memory) never leaves a blank page.
		const onCreated = () => console.log('[shell] activityCreated');
		const onDestroyed = (args: any) => console.log(`[shell] activityDestroyed (finishing ${args.activity?.isFinishing?.()})`);
		Application.android.on(Application.android.activityBackPressedEvent, onBack);
		Application.android.on(Application.android.activityCreatedEvent, onCreated);
		Application.android.on(Application.android.activityDestroyedEvent, onDestroyed);
		return () => {
			Application.android.off(Application.android.activityBackPressedEvent, onBack);
			Application.android.off(Application.android.activityCreatedEvent, onCreated);
			Application.android.off(Application.android.activityDestroyedEvent, onDestroyed);
		};
	}, [goBack]);

	const services: AppServices | null = React.useMemo(
		() =>
			settings && {
				settings,
				profile,
				locationDb,
				stack,
				navigate: dispatch,
				goBack,
				setBackGuard: (guard) => {
					backGuardRef.current = guard;
				},
				reloadProfile: async () => {
					try {
						await applyProfile(settings);
					} catch (error) {
						await Dialogs.alert({ title: 'Location database', message: String(error), okButtonText: 'OK' });
					}
				},
			},
		[settings, profile, locationDb, stack, applyProfile, goBack],
	);

	return (
		<frame>
			<page actionBarHidden={true} statusBarStyle="dark">
				{services ? (
					<AppContext.Provider value={services}>
						<Screen route={currentRoute(stack)} />
					</AppContext.Provider>
				) : (
					<stackLayout className="content" verticalAlignment="middle">
						<label className={startupError ? 'error' : 'hint'} textWrap={true} text={startupError ?? 'Opening…'} />
					</stackLayout>
				)}
			</page>
		</frame>
	);
}
