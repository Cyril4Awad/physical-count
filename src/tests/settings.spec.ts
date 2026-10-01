/** Step 3: settings database, location profiles and device settings (REBUILD_PLAN §2.2, §4.1). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseFileExists, deleteDatabaseFile } from '../storage/database';
import { clearDeviceSettings, getMachineName, getPageSize, getScannerInput, ScannerInput, setMachineName, setPageSize, setScannerInput } from '../storage/deviceSettings';
import { runDownload } from '../storage/download';
import { LocationDb, locationDbFileName } from '../storage/locationDb';
import { SettingsDb } from '../storage/settingsDb';
import { count9Source, manifestEntries } from './helpers';

const SETTINGS_FILE = 'PhysicalCountSettings_TEST';
// Test-only location codes, so no real location database is touched.
const TEST_LOCATIONS = ['Q1', 'q1', 'Q2', 'Q3'];

let settings: SettingsDb;

function removeTestFiles() {
	deleteDatabaseFile(SETTINGS_FILE);
	TEST_LOCATIONS.forEach((loc) => deleteDatabaseFile(locationDbFileName(loc)));
}

beforeEach(async () => {
	settings?.close();
	removeTestFiles();
	settings = await SettingsDb.open(SETTINGS_FILE);
});

afterAll(() => {
	settings?.close();
	removeTestFiles();
});

async function selectedCount(): Promise<number> {
	return (await settings.listProfiles()).filter((p) => p.selected).length;
}

describe('location profiles', () => {
	it('adds a profile, keeping the location code exactly as typed', async () => {
		const added = await settings.addProfile('q1', '10.0.2.2:5000');
		// (expect.any() is not available in the on-device vitest shim.)
		expect(added).toMatchObject({ ok: true, value: { location: 'q1', serverAddress: '10.0.2.2:5000', selected: false } });
		expect(added.ok && typeof added.value.id).toBe('number');
		expect(await settings.selectedProfile()).toBeNull();
	});

	it('refuses the same location twice, whatever the case', async () => {
		await settings.addProfile('Q1', 'erp-q1');
		expect(await settings.addProfile('q1', 'erp-other')).toEqual({ ok: false, message: 'Location q1 already has a profile.' });
		expect(await settings.addProfile('Q1', 'erp-q1')).toMatchObject({ ok: false });
		expect(await settings.listProfiles()).toHaveLength(1);
	});

	it('checks the fields (§3.7)', async () => {
		expect(await settings.addProfile('Q12', 'erp')).toMatchObject({ ok: false, message: 'The location code is 1 or 2 letters or digits.' });
		expect(await settings.addProfile('Q1', 'http://erp')).toMatchObject({ ok: false });
		expect(await settings.addProfile('Q1', 'erp/ERPDataCollector')).toMatchObject({ ok: false });
		expect(await settings.listProfiles()).toHaveLength(0);
	});

	it('edits a profile, with the duplicate check excluding itself', async () => {
		const q1 = await settings.addProfile('Q1', 'erp-q1');
		const q2 = await settings.addProfile('Q2', 'erp-q2');
		if (!q1.ok || !q2.ok) throw new Error('setup failed');
		expect(await settings.editProfile(q1.value.id, 'Q1', 'erp-q1:8080')).toMatchObject({ ok: true, value: { serverAddress: 'erp-q1:8080' } });
		expect(await settings.editProfile(q1.value.id, 'q2', 'erp-q1')).toEqual({ ok: false, message: 'Location q2 already has a profile.' });
		expect(await settings.editProfile(9999, 'Q3', 'erp')).toEqual({ ok: false, message: 'This profile no longer exists.' });
	});

	it('selects one profile at a time, in one transaction', async () => {
		const q1 = await settings.addProfile('Q1', 'erp-q1', { select: true });
		const q2 = await settings.addProfile('Q2', 'erp-q2');
		if (!q1.ok || !q2.ok) throw new Error('setup failed');
		expect(await settings.selectedProfile()).toMatchObject({ location: 'Q1' });

		expect(await settings.selectProfile(q2.value.id)).toMatchObject({ ok: true, value: { location: 'Q2', selected: true } });
		expect(await settings.selectedProfile()).toMatchObject({ location: 'Q2' });
		expect(await selectedCount()).toBe(1);

		const q3 = await settings.addProfile('Q3', 'erp-q3', { select: true });
		expect(q3).toMatchObject({ ok: true, value: { selected: true } });
		expect(await selectedCount()).toBe(1);

		// Selecting a profile that does not exist changes nothing.
		expect(await settings.selectProfile(9999)).toEqual({ ok: false, message: 'This profile no longer exists.' });
		expect(await settings.selectedProfile()).toMatchObject({ location: 'Q3' });
	});

	it('deleting the selected profile leaves none selected', async () => {
		const q1 = await settings.addProfile('Q1', 'erp-q1', { select: true });
		if (!q1.ok) throw new Error('setup failed');
		await settings.deleteProfile(q1.value.id);
		expect(await settings.selectedProfile()).toBeNull();
		expect(await selectedCount()).toBe(0);
	});

	it('warns about counted lines not uploaded, and keeps the location database', async () => {
		const q1 = await settings.addProfile('Q1', 'erp-q1', { select: true });
		if (!q1.ok) throw new Error('setup failed');

		// No database yet: no warning, and no file is created by asking.
		expect(await settings.deleteWarning(q1.value.id)).toMatchObject({ pendingCount: 0 });
		expect(databaseFileExists(locationDbFileName('Q1'))).toBe(false);

		const db = LocationDb.open(locationDbFileName('Q1'));
		await db.ensureSchema();
		await db.startDownload('9', 'V2', 'UN3', manifestEntries('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3'));
		await runDownload(db, count9Source().fetchPage, { pageSize: 50 });
		await db.setCount('47842', 3000n);
		await db.setCount('47843', 1000n);
		db.close();

		expect(await settings.deleteWarning(q1.value.id)).toMatchObject({ profile: { location: 'Q1' }, pendingCount: 2 });
		await settings.deleteProfile(q1.value.id);
		expect(await settings.listProfiles()).toHaveLength(0);
		expect(databaseFileExists(locationDbFileName('Q1'))).toBe(true);

		// Re-adding the location finds its sheet and counts again.
		await settings.addProfile('Q1', 'erp-q1', { select: true });
		const again = LocationDb.open(locationDbFileName('Q1'));
		expect(await again.pendingCount()).toBe(2);
		again.close();
	});

	it('keeps profiles after the settings database is closed and reopened', async () => {
		await settings.addProfile('Q1', 'erp-q1', { select: true });
		settings.close();
		settings = await SettingsDb.open(SETTINGS_FILE);
		expect(await settings.selectedProfile()).toMatchObject({ location: 'Q1', serverAddress: 'erp-q1' });
	});
});

describe('switching profiles switches the location database', () => {
	it('each location keeps its own sheet and counts', async () => {
		const q1 = await settings.addProfile('Q1', 'erp-q1', { select: true });
		const q2 = await settings.addProfile('Q2', 'erp-q2');
		if (!q1.ok || !q2.ok) throw new Error('setup failed');

		async function openSelected(): Promise<LocationDb> {
			const profile = await settings.selectedProfile();
			if (!profile) throw new Error('no profile selected');
			const db = LocationDb.open(locationDbFileName(profile.location));
			await db.ensureSchema();
			return db;
		}

		// Location Q1 downloads and counts.
		let db = await openSelected();
		await db.startDownload('9', 'V2', 'UN3', manifestEntries('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3'));
		await runDownload(db, count9Source().fetchPage, { pageSize: 50 });
		await db.setCount('47842', 4000n);
		db.close();

		// Switch to Q2: an empty location, no sheet.
		await settings.selectProfile(q2.value.id);
		db = await openSelected();
		expect(await db.sheetInfo()).toBeNull();
		expect(await db.counters()).toEqual({ lines: 0, notCounted: 0, pending: 0, uploaded: 0 });
		db.close();

		// Back to Q1: its sheet and count are still there.
		await settings.selectProfile(q1.value.id);
		db = await openSelected();
		expect(await db.sheetInfo()).toMatchObject({ countNumber: '9' });
		expect((await db.getLine('47842'))?.counted).toBe(4000n);
		db.close();

		expect(databaseFileExists(locationDbFileName('Q1'))).toBe(true);
		expect(databaseFileExists(locationDbFileName('Q2'))).toBe(true);
	});
});

describe('device settings (ApplicationSettings)', () => {
	// The test build shares the app's storage: keep the emulator's real values.
	let savedMachine = '';
	let savedPageSize = '';
	let savedScannerInput: ScannerInput = 'keyEvents';
	beforeAll(() => {
		savedMachine = getMachineName();
		savedPageSize = String(getPageSize());
		savedScannerInput = getScannerInput();
	});
	afterAll(() => {
		clearDeviceSettings();
		if (savedMachine) setMachineName(savedMachine);
		setPageSize(savedPageSize);
		setScannerInput(savedScannerInput);
	});

	it('scanner input: key events by default, text input when chosen (§9.3)', () => {
		clearDeviceSettings();
		expect(getScannerInput()).toBe('keyEvents');
		setScannerInput('textInput');
		expect(getScannerInput()).toBe('textInput');
		setScannerInput('keyEvents');
		expect(getScannerInput()).toBe('keyEvents');
	});

	it('defaults: no machine name, page size 1000 (Q13)', () => {
		clearDeviceSettings();
		expect(getMachineName()).toBe('');
		expect(getPageSize()).toBe(1000);
	});

	it('stores only valid values', () => {
		expect(setMachineName('UN3')).toEqual({ ok: true, value: 'UN3' });
		expect(setMachineName('TOOLONG').ok).toBe(false);
		expect(getMachineName()).toBe('UN3');
		expect(setPageSize('5000')).toEqual({ ok: true, value: 5000 });
		expect(setPageSize('').ok).toBe(false);
		expect(setPageSize('5001').ok).toBe(false);
		expect(getPageSize()).toBe(5000);
	});
});
