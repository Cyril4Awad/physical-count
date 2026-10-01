/** Step 3: location database — schema, staged download, resume, counting (REBUILD_PLAN §4, §5, §6.1). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expirySortKey } from '../domain/itemText';
import { lookupScan } from '../domain/lookup';
import { ServiceDataError } from '../parse/errors';
import { readPullRecords } from '../soap/responses';
import { Database } from '../storage/database';
import { runDownload } from '../storage/download';
import { deleteLocationDbFile, Line, LocationDb, SheetLockedError } from '../storage/locationDb';
import { PHY_TABLES, SCHEMA_VERSION } from '../storage/schema';
import { count9Source, manifestEntries, records, recordsResponse } from './helpers';

const FILE = 'ERPDataCollectorNDB_STORAGE';
const COUNT9 = manifestEntries('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3');
const PAGE = 50;

let db: LocationDb;
const opened: LocationDb[] = [];

function openDb(): LocationDb {
	db = LocationDb.open(FILE);
	opened.push(db);
	return db;
}

async function freshDb(): Promise<LocationDb> {
	opened.forEach((d) => d.close());
	opened.length = 0;
	deleteLocationDbFile(FILE);
	openDb();
	await db.ensureSchema();
	return db;
}

/** A complete count 9 download, so there is a live sheet to protect. */
async function downloadCount9(): Promise<void> {
	await db.startDownload('9', 'V2', 'UN3', COUNT9);
	expect(await runDownload(db, count9Source().fetchPage, { pageSize: PAGE })).toEqual({ kind: 'completed' });
}

async function stagedCounts(): Promise<number[]> {
	return Promise.all(PHY_TABLES.map((t) => db.count(`stg_${t}`)));
}

async function liveCounts(): Promise<number[]> {
	return Promise.all(PHY_TABLES.map((t) => db.count(t)));
}

afterAll(() => {
	opened.forEach((d) => d.close());
	deleteLocationDbFile(FILE);
});

describe('location database schema', () => {
	it('creates every table from the app constants and sets user_version', async () => {
		await freshDb();
		expect(await db.userVersion()).toBe(SCHEMA_VERSION);
		expect(await liveCounts()).toEqual([0, 0, 0]);
		expect(await stagedCounts()).toEqual([0, 0, 0]);
		expect(await db.pullStatus()).toEqual([]);
		expect(await db.sheetInfo()).toBeNull();
		expect(await db.counters()).toEqual({ lines: 0, notCounted: 0, pending: 0, uploaded: 0 });
	});

	it('does nothing on an existing database', async () => {
		await db.ensureSchema();
		expect(await db.userVersion()).toBe(SCHEMA_VERSION);
	});
});

describe('staged download', () => {
	beforeEach(freshDb);

	it('writes the manifest without touching the live tables', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const status = await db.pullStatus();
		expect(status.map((s) => [s.table, s.rowsCount, s.rowsStored, s.finished])).toEqual([
			['phyHeader', 1, 0, false],
			['phyDetails', 102, 0, false],
			['phyBarcodes', 0, 0, true],
		]);
		expect(status[1].tableName).toBe('_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3');
		expect(await db.isDownloadInProgress()).toBe(true);
		expect(await liveCounts()).toEqual([0, 0, 0]);
	});

	it('downloads count 9 page by page, then swaps it in and clears staging', async () => {
		const source = count9Source();
		const progress: number[] = [];
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const outcome = await runDownload(db, source.fetchPage, { pageSize: PAGE, onProgress: (p) => progress.push(p.rowsStored) });

		expect(outcome).toEqual({ kind: 'completed' });
		expect(source.requests.map((r) => `${r.tableName.split('_')[3]}:${r.startFromRow}:${r.pageSize}`)).toEqual([
			'PhysicalCountHeader:1:50',
			'PhysicalCountDetail:1:50',
			'PhysicalCountDetail:51:50',
			'PhysicalCountDetail:101:50',
		]);
		expect(progress).toEqual([1, 50, 100, 102]);
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(await stagedCounts()).toEqual([0, 0, 0]);
		expect(await db.isDownloadInProgress()).toBe(false);

		const sheet = await db.sheetInfo();
		expect(sheet).toMatchObject({ countNumber: '9', machineName: 'UN3', invId: '9', userToUpdate: '4', spDecNo: '3', spExpiry: 'Y', warehouse: 'wh1' });
		const details = await db.selectAll('phyDetails');
		expect(details.map((d) => d._id)).toEqual(details.map((d) => d.RowNumber));
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 102, pending: 0, uploaded: 0 });
	});

	it('updates RowsStored in the same transaction as the page', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const details = COUNT9[1];
		const { toPageRows } = await import('../parse/rows');
		const rows = toPageRows(details.columnMap, records('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'));
		expect(await db.storePage('phyDetails', rows)).toEqual({ inserted: 50, skipped: 0, rowsStored: 50, finished: false });
		expect((await db.pullStatus())[1].rowsStored).toBe(50);
		expect(await db.count('stg_phyDetails')).toBe(50);
	});

	it('refuses to swap an incomplete download and changes nothing', async () => {
		await downloadCount9();
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		await expect(db.applyDownload()).rejects.toThrow('not complete');
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(await db.isDownloadInProgress()).toBe(true);
	});
});

describe('a failed, cancelled or corrupted download leaves the live sheet untouched', () => {
	beforeEach(async () => {
		await freshDb();
		await downloadCount9();
		await db.setCount('47842', 5000n);
		await db.setCount('47843', 2500n);
	});

	async function liveIsUntouched() {
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(await db.pendingCount()).toBe(2);
		expect((await db.getLine('47842'))?.counted).toBe(5000n);
		expect(await db.sheetInfo()).toMatchObject({ countNumber: '9' });
	}

	it('network failure on the second details page', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const source = count9Source((r) => (r.startFromRow === 51 ? 'fail' : undefined));
		await expect(runDownload(db, source.fetchPage, { pageSize: PAGE })).rejects.toThrow('Simulated network failure');
		await liveIsUntouched();
		expect((await db.pullStatus())[1].rowsStored).toBe(50);
		expect(await db.isDownloadInProgress()).toBe(true);
	});

	it('the live sheet is locked while a download is in progress (§5.1)', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		await expect(db.setCount('47842', 9000n)).rejects.toThrow(SheetLockedError);
		await expect(db.restoreUploaded()).rejects.toThrow(SheetLockedError);
		await liveIsUntouched();
	});

	it('cancel between pages', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		let pages = 0;
		const outcome = await runDownload(db, count9Source().fetchPage, { pageSize: PAGE, shouldCancel: () => pages >= 2, onProgress: () => pages++ });
		expect(outcome).toEqual({ kind: 'cancelled' });
		expect(await stagedCounts()).toEqual([1, 50, 0]);
		await liveIsUntouched();
	});

	it('a corrupted page is rejected whole: nothing from it is staged, and the download can continue', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const good = records('pullRecords.count9-V2-UN3.phyDetails.from51.response.xml');
		const corrupted = [...good.slice(0, 10), "'61','47902','V2'); DELETE FROM phyDetails; --", ...good.slice(11)];
		const source = count9Source((r) => (r.startFromRow === 51 ? readPullRecords(recordsResponse(corrupted)) : undefined));

		await expect(runDownload(db, source.fetchPage, { pageSize: PAGE })).rejects.toThrow(ServiceDataError);
		expect((await db.pullStatus())[1].rowsStored).toBe(50);
		expect(await db.count('stg_phyDetails')).toBe(50);
		await liveIsUntouched();

		// The server answers correctly on retry: Continue download finishes and swaps.
		expect(await runDownload(db, count9Source().fetchPage, { pageSize: PAGE })).toEqual({ kind: 'completed' });
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(await db.pendingCount()).toBe(0);
	});

	it('a database failure inside a page rolls back that page and its RowsStored', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		// Rows 51–100 with row 60 repeating Pcd_RecId 47842: the unique index fails mid-page.
		const page = records('pullRecords.count9-V2-UN3.phyDetails.from51.response.xml').map((v) => (v.startsWith("'60',") ? v.replace(/^'60','[0-9]+'/, "'60','47842'") : v));
		const source = count9Source((r) => (r.startFromRow === 51 ? readPullRecords(recordsResponse(page)) : undefined));
		await expect(runDownload(db, source.fetchPage, { pageSize: PAGE })).rejects.toThrow();
		expect(await db.count('stg_phyDetails')).toBe(50);
		expect((await db.pullStatus())[1].rowsStored).toBe(50);
		await liveIsUntouched();
	});

	it('Abandon clears staging and releases the lock without touching the live sheet', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		let pages = 0;
		await runDownload(db, count9Source().fetchPage, { pageSize: PAGE, shouldCancel: () => pages >= 2, onProgress: () => pages++ });
		expect(await stagedCounts()).toEqual([1, 50, 0]);
		await db.abandonDownload();
		expect(await db.isDownloadInProgress()).toBe(false);
		expect(await stagedCounts()).toEqual([0, 0, 0]);
		await liveIsUntouched();
		await db.setCount('47842', 6000n);
		expect((await db.getLine('47842'))?.counted).toBe(6000n);
	});

	it('a completed re-download replaces the sheet and its counts (after the D8 warning)', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		expect(await runDownload(db, count9Source().fetchPage, { pageSize: PAGE })).toEqual({ kind: 'completed' });
		expect(await db.pendingCount()).toBe(0);
		expect((await db.getLine('47842'))?.counted).toBe(0n);
	});
});

describe('resume', () => {
	beforeEach(freshDb);

	it('after the app is killed between pages (reopen the database), continues from RowsStored + 1', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		let pages = 0;
		expect(await runDownload(db, count9Source().fetchPage, { pageSize: PAGE, shouldCancel: () => pages >= 2, onProgress: () => pages++ })).toEqual({
			kind: 'cancelled',
		});
		db.close();

		openDb();
		await db.ensureSchema();
		expect((await db.pullStatus()).map((s) => s.rowsStored)).toEqual([1, 50, 0]);
		const source = count9Source();
		expect(await runDownload(db, source.fetchPage, { pageSize: PAGE })).toEqual({ kind: 'completed' });
		expect(source.requests.map((r) => r.startFromRow)).toEqual([51, 101]);
		expect(await liveCounts()).toEqual([1, 102, 0]);
	});

	it('de-duplicates by RowNumber when a page overlaps rows already stored', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const first = records('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml');
		const second = records('pullRecords.count9-V2-UN3.phyDetails.from51.response.xml');
		const last = records('pullRecords.count9-V2-UN3.phyDetails.from101.response.xml');
		const source = count9Source((r) => {
			// Asked for 51–100, the server answers 41–90 (10 rows already stored).
			if (r.startFromRow === 51) return readPullRecords(recordsResponse([...first.slice(40), ...second.slice(0, 40)]));
			if (r.startFromRow === 91) return readPullRecords(recordsResponse([...second.slice(40), ...last]));
			return undefined;
		});
		const stored: number[] = [];
		expect(await runDownload(db, source.fetchPage, { pageSize: PAGE, onProgress: (p) => stored.push(p.rowsStored) })).toEqual({ kind: 'completed' });
		expect(source.requests.map((r) => r.startFromRow)).toEqual([1, 1, 51, 91]);
		expect(stored).toEqual([1, 50, 90, 102]);
		expect(await db.count('phyDetails')).toBe(102);
	});

	it('stops with "stalled" when the server returns no new rows before RowsCount (§3.4)', async () => {
		await db.startDownload('9', 'V2', 'UN3', COUNT9);
		const source = count9Source((r) => (r.startFromRow === 51 ? { kind: 'noResults' } : undefined));
		expect(await runDownload(db, source.fetchPage, { pageSize: PAGE })).toEqual({ kind: 'stalled', table: 'phyDetails', rowsStored: 50, rowsCount: 102 });
		expect(await db.isDownloadInProgress()).toBe(true);
	});
});

describe('counting on the live sheet', () => {
	beforeEach(async () => {
		await freshDb();
		await downloadCount9();
	});

	it('writes usercounted and updated = 1, and feeds the D8 count and the Home counters', async () => {
		await db.setCount('47842', 8500n);
		const line = await db.getLine('47842');
		expect(line).toMatchObject({ pcdRecId: '47842', reference: 'N/PD/SEL/1/N', expiry: '01.01.2025', counted: 8500n, state: '1' });
		expect((await db.selectAll('phyDetails'))[0].usercounted).toBe('8.500');
		expect(await db.pendingCount()).toBe(1);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 101, pending: 1, uploaded: 0 });
	});

	it('refuses a line that is not in the sheet', async () => {
		await expect(db.setCount('99999999', 1000n)).rejects.toThrow('not in the downloaded sheet');
	});

	it('Restore uploaded turns every uploaded line back into pending', async () => {
		await db.setCount('47842', 1000n);
		await db.setCount('47843', 2000n);
		await db.markUploaded('47842');
		await db.markUploaded('47843');
		expect(await db.counters()).toMatchObject({ pending: 0, uploaded: 2 });
		expect(await db.restoreUploaded()).toBe(2);
		expect(await db.counters()).toMatchObject({ pending: 2, uploaded: 0 });
		expect(await db.pendingCount()).toBe(2);
	});

	it('a scan on an uploaded line makes it pending again', async () => {
		await db.setCount('47842', 1000n);
		await db.markUploaded('47842');
		await db.setCount('47842', 2000n);
		expect((await db.getLine('47842'))?.state).toBe('1');
	});
});

describe('Items lists (step 8)', () => {
	beforeEach(async () => {
		await freshDb();
		await downloadCount9();
	});

	const rowNumbers = (lines: { rowNumber: number }[]) => lines.map((l) => l.rowNumber);

	it('pages the not-counted lines in RowNumber order; the counted list starts empty', async () => {
		const first = await db.listLines('0', 0, 100);
		expect(rowNumbers(first)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
		expect(first[0]).toMatchObject({ pcdRecId: '47842', reference: 'N/PD/SEL/1/N', expiry: '01.01.2025', counted: 0n, state: '0' });
		expect(rowNumbers(await db.listLines('0', 100, 100))).toEqual([101, 102]);
		expect(await db.listLines('0', 102, 100)).toEqual([]);
		expect(rowNumbers(await db.listLines('0', 37, 5))).toEqual([38, 39, 40, 41, 42]);
		expect(await db.listLines('1', 0, 100)).toEqual([]);
	});

	it('a counted line moves to the counted list, in RowNumber order whatever the counting order', async () => {
		await db.setCount('47901', 2750n);
		await db.setCount('47843', 3000n);
		await db.setCount('47842', 10000000n);
		const counted = await db.listLines('1', 0, 100);
		expect(counted.map((l) => [l.pcdRecId, l.counted])).toEqual([
			['47842', 10000000n],
			['47843', 3000n],
			['47901', 2750n],
		]);
		const notCounted = await db.listLines('0', 0, 200);
		expect(notCounted).toHaveLength(99);
		expect(notCounted.some((l) => ['47842', '47843', '47901'].includes(l.pcdRecId))).toBe(false);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 99, pending: 3, uploaded: 0 });
	});

	it('an uploaded line is in neither list, and leaves the pending count', async () => {
		await db.setCount('47842', 1000n);
		await db.setCount('47843', 2000n);
		await db.markUploaded('47842');
		expect((await db.listLines('1', 0, 100)).map((l) => l.pcdRecId)).toEqual(['47843']);
		expect((await db.listLines('0', 0, 200)).some((l) => l.pcdRecId === '47842')).toBe(false);
		expect((await db.listLines('2', 0, 100)).map((l) => l.pcdRecId)).toEqual(['47842']);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 100, pending: 1, uploaded: 1 });
		expect(await db.pendingCount()).toBe(1);
	});

	it('refuses an offset or limit that is not a whole number in range', async () => {
		await expect(db.listLines('0', -1, 100)).rejects.toThrow('Invalid offset');
		await expect(db.listLines('0', 0, 0)).rejects.toThrow('Invalid limit');
		await expect(db.listLines('0', 0.5, 100)).rejects.toThrow('Invalid offset');
	});

});

describe('schema upgrades keep the sheet and its counts', () => {
	beforeEach(async () => {
		await freshDb();
		await downloadCount9();
	});

	/** Turns the current database file into the shape an older app version left: version 1 or 2. */
	async function downgradeTo(version: 1 | 2): Promise<void> {
		db.close();
		opened.length = 0;
		const raw = Database.open(FILE);
		await raw.inTransaction(async () => {
			// Version 1 had no Items index (added in 2); versions 1 and 2 had the four-column tblSheet (two more in 3).
			if (version === 1) await raw.execute('DROP INDEX ix_phyDetails_state_row');
			await raw.execute('ALTER TABLE tblSheet RENAME TO tblSheet_current');
			await raw.execute('CREATE TABLE tblSheet(_id INTEGER PRIMARY KEY CHECK (_id = 1), CountNumber TEXT, MachineName TEXT, DownloadedAt TEXT)');
			await raw.execute('INSERT INTO tblSheet(_id, CountNumber, MachineName, DownloadedAt) SELECT _id, CountNumber, MachineName, DownloadedAt FROM tblSheet_current');
			await raw.execute('DROP TABLE tblSheet_current');
		});
		await raw.setUserVersion(version);
		raw.close();
	}

	const totalsAndStates = async () => (await db.selectAll('phyDetails')).map((row) => `${row.Pcd_RecId}:${row.usercounted}:${row.updated}`);

	for (const version of [1, 2] as const) {
		it(`version ${version} → ${SCHEMA_VERSION}: every counted total and line state survives (states 0, 1 and 2)`, async () => {
			// Counted, not uploaded (state 1), with decimals and a large total.
			await db.setCount('47843', 2750n);
			await db.setCount('47901', 125n);
			await db.setCount('47902', 10000000n);
			// Uploaded (state 2).
			await db.setCount('47842', 5000n);
			await db.setCount('47844', 31500n);
			await db.markUploaded('47842');
			await db.markUploaded('47844');
			const before = await totalsAndStates();
			const sheetBefore = await db.sheetInfo();
			expect(before).toHaveLength(102);
			expect(before.filter((line) => line.endsWith(':1'))).toEqual(['47843:2.750:1', '47901:0.125:1', '47902:10000.000:1']);
			expect(before.filter((line) => line.endsWith(':2'))).toEqual(['47842:5.000:2', '47844:31.500:2']);

			await downgradeTo(version);
			openDb();
			expect(await db.userVersion()).toBe(version);
			await db.ensureSchema();

			expect(await db.userVersion()).toBe(SCHEMA_VERSION);
			expect(await totalsAndStates()).toEqual(before);
			expect(await db.counters()).toEqual({ lines: 102, notCounted: 97, pending: 3, uploaded: 2 });
			expect((await db.listLines('1', 0, 10)).map((l) => [l.pcdRecId, l.counted])).toEqual([
				['47843', 2750n],
				['47901', 125n],
				['47902', 10000000n],
			]);
			expect((await db.listLines('2', 0, 10)).map((l) => l.pcdRecId)).toEqual(['47842', '47844']);
			// The sheet row is kept; the new "last upload" fields start empty and can be written.
			expect(await db.sheetInfo()).toEqual({ ...sheetBefore, lastUploadAt: '', lastUploadLines: 0 });
			await db.recordUpload('2026-10-01T08:15:00.000Z', 2);
			expect(await db.sheetInfo()).toMatchObject({ countNumber: '9', lastUploadAt: '2026-10-01T08:15:00.000Z', lastUploadLines: 2 });
			// Counting still works on the upgraded database.
			await db.setCount('47843', 3750n);
			expect((await db.getLine('47843'))?.counted).toBe(3750n);

			db.close();
			opened.length = 0;
			const check = Database.open(FILE);
			expect(await check.scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'ix_phyDetails_state_row'")).toBe(1);
			const plan = await check.select("EXPLAIN QUERY PLAN SELECT RowNumber FROM phyDetails WHERE updated = '0' ORDER BY RowNumber LIMIT 100 OFFSET 5000");
			const detail = plan.map((row) => String(row.detail)).join(' | ');
			expect(detail).toContain('ix_phyDetails_state_row');
			expect(detail).not.toContain('TEMP B-TREE');
			check.close();
			openDb();
		});
	}

	it('running the upgrade again changes nothing', async () => {
		await db.setCount('47843', 2750n);
		await db.recordUpload('2026-10-01T08:15:00.000Z', 1);
		const before = await totalsAndStates();
		await db.ensureSchema();
		expect(await totalsAndStates()).toEqual(before);
		expect(await db.sheetInfo()).toMatchObject({ lastUploadAt: '2026-10-01T08:15:00.000Z', lastUploadLines: 1 });
	});
});

describe('Pick item order (step 8)', () => {
	beforeEach(async () => {
		await freshDb();
		await downloadCount9();
	});

	const byExpiryThenRow = (lines: Line[]) => [...lines].sort((a, b) => expirySortKey(a.expiry).localeCompare(expirySortKey(b.expiry)) || a.rowNumber - b.rowNumber);

	it('sorts by expiry, oldest first, then RowNumber', async () => {
		const byRow = await db.searchByReferencePrefix('N/PD/SEL', 100);
		const sorted = await db.searchByReferencePrefix('N/PD/SEL', 100, { byExpiry: true });
		expect(sorted).toHaveLength(72);
		expect(sorted.map((l) => l.pcdRecId)).toEqual(byExpiryThenRow(byRow).map((l) => l.pcdRecId));
		// The sample has lots out of date order, so this is a real re-ordering.
		expect(sorted.map((l) => l.pcdRecId)).not.toEqual(byRow.map((l) => l.pcdRecId));
		const keys = sorted.map((l) => expirySortKey(l.expiry));
		expect(keys).toEqual([...keys].sort());
	});

	it('sorts before it limits: the first five are the five oldest', async () => {
		const all = await db.searchByReferencePrefix('N/PD/SEL', 100);
		const five = await db.searchByReferencePrefix('N/PD/SEL', 5, { byExpiry: true });
		expect(five.map((l) => l.pcdRecId)).toEqual(
			byExpiryThenRow(all)
				.slice(0, 5)
				.map((l) => l.pcdRecId),
		);
	});

	it('the seven lots of one item: month-only expiry 01.2050 comes after 01.01.2025', async () => {
		const lots = await db.searchByReferencePrefix('n/pd/sel/1/n', 100, { byExpiry: true });
		expect(lots).toHaveLength(7);
		const ids = lots.map((l) => l.pcdRecId);
		expect(ids.indexOf('47842')).toBeLessThan(ids.indexOf('47844'));
		expect(ids).toEqual(byExpiryThenRow(lots).map((l) => l.pcdRecId));
	});
});

describe('lookup repository on real SQLite', () => {
	beforeEach(freshDb);

	it('follows the legacy order and SQLite LIKE semantics', async () => {
		await downloadCount9();
		const repo = db.lookupRepository();
		// Unique reference, typed in lower case: counted directly.
		expect(await lookupScan('n/pd/sel/13/n', repo)).toMatchObject({ kind: 'found', lineId: '47901', via: 'reference' });
		// N/PD/SEL/1/N is one item in 7 lots (7 lines): Pick item.
		expect(await lookupScan('N/PD/SEL/1/N', repo)).toEqual({ kind: 'pick', value: 'N/PD/SEL/1/N' });
		expect(await lookupScan('N/PD/SEL', repo)).toEqual({ kind: 'pick', value: 'N/PD/SEL' });
		// The QR sticker picks the lot: day 00 → MM.YYYY expiry.
		expect(await lookupScan('992|00/01/2050|107879', repo)).toMatchObject({ kind: 'found', lineId: '47844', via: 'qr' });
		expect(await lookupScan('N/PD/SEL%', repo)).toMatchObject({ kind: 'notFound' });
		expect(await lookupScan('N_PD', repo)).toMatchObject({ kind: 'notFound' });
		expect(await lookupScan('992|01/01/2025|J16-3135', repo)).toMatchObject({ kind: 'found', lineId: '47842', via: 'qr' });
		expect(await lookupScan('992|01/01/25|J16-3135', repo)).toMatchObject({ kind: 'notFound' });
		expect(await lookupScan('992|01/01/25', repo)).toMatchObject({ kind: 'invalidQr' });
	});

	it('Pick item search: prefix, case-insensitive, RowNumber order, limit, % and _ literal', async () => {
		await downloadCount9();
		const lots = await db.searchByReferencePrefix('n/pd/sel/1/n', 100);
		expect(lots.map((l) => l.pcdRecId)).toEqual(['47842', '47843', '47844', '47845', '47846', '47847', '47848']);
		expect(lots[2]).toMatchObject({ reference: 'N/PD/SEL/1/N', expiry: '01.2050', batch: '107879', counted: 0n, state: '0' });
		expect(await db.searchByReferencePrefix('N/PD/SEL', 5)).toHaveLength(5);
		expect(await db.searchByReferencePrefix('N/PD/SEL', 100)).toHaveLength(72);
		expect(await db.searchByReferencePrefix('N/PD/SEL%', 100)).toHaveLength(0);
		expect(await db.searchByReferencePrefix('N_PD', 100)).toHaveLength(0);
		await expect(db.searchByReferencePrefix('N', 0)).rejects.toThrow('Invalid limit');
	});

	it('takes the first barcode row by RowNumber (Q7) and ignores barcodes of lines not in the sheet', async () => {
		const entries = manifestEntries('InitPullTables.count10-CV-UN.response.xml', 'CV', 'UN');
		const { toPageRows } = await import('../parse/rows');
		const details = toPageRows(entries[1].columnMap, records('pullRecords.count10-CV-UN.phyDetails.from1.response.xml'));
		// Put the two lines of barcode 2000000000848 into the sheet (their ids come from the barcode sample).
		const template = details[0];
		const withId = (rowNumber: number, recId: string) => ({ rowNumber, values: [String(rowNumber), recId, ...template.values.slice(2)] });
		await db.insertPage('phyHeader', toPageRows(entries[0].columnMap, records('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml')));
		await db.insertPage('phyDetails', [withId(1, '40767'), withId(2, '36341')]);
		await db.insertPage('phyBarcodes', toPageRows(entries[2].columnMap, records('pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml')));

		const repo = db.lookupRepository();
		expect(await repo.findByBarcode('2000000000848')).toBe('40767');
		expect(await repo.findByBarcode('5285002192105')).toBeNull();
		expect(await repo.findByBarcode('')).toBeNull();
	});
});
