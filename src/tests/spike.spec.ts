/**
 * Step 1 spike (REBUILD_PLAN §14): read the saved InitPullTables and
 * pullRecords responses, parse them with the parser, and insert them into
 * SQLite on the device. No screens.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ServiceDataError } from '../parse/errors';
import { buildManifest, ManifestEntry } from '../parse/manifest';
import { PageRow, toPageRows } from '../parse/rows';
import { readInitPullTables, readPullRecords } from '../soap/responses';
import { deleteLocationDbFile, LocationDb, locationDbFileName } from '../storage/locationDb';
import { COLUMNS, PhyTable } from '../storage/schema';

declare const require: any;
const samples = require.context('../../docs/service-samples', false, /\.response\.xml$/);

function sample(name: string): string {
	const loaded = samples(`./${name}`);
	return typeof loaded === 'string' ? loaded : loaded.default;
}

function manifestFor(name: string, location: string, machine: string): Map<PhyTable, ManifestEntry> {
	const result = readInitPullTables(sample(name));
	if (result.kind !== 'tables') throw new Error('expected tables');
	const manifest = buildManifest(result.tables, location, machine);
	if (manifest.kind !== 'ok') throw new Error('expected a downloadable count');
	return new Map(manifest.entries.map((e) => [e.originalTableName, e]));
}

function entryOf(manifest: Map<PhyTable, ManifestEntry>, table: PhyTable): ManifestEntry {
	const entry = manifest.get(table);
	if (!entry) throw new Error(`No ${table} in the manifest`);
	return entry;
}

function pageRows(entry: ManifestEntry, xml: string): PageRow[] {
	const result = readPullRecords(xml);
	return result.kind === 'records' ? toPageRows(entry.columnMap, result.valuesQueries) : [];
}

function field(table: PhyTable, row: PageRow, name: string): string {
	return row.values[COLUMNS[table].indexOf(name)];
}

function freshDb(fileName: string): LocationDb {
	deleteLocationDbFile(fileName);
	return LocationDb.open(fileName);
}

const openDbs: LocationDb[] = [];
afterAll(() => openDbs.forEach((db) => db.close()));

describe('spike: count 9 / V2 / UN3 into ERPDataCollectorNDB_TEST', () => {
	const fileName = 'ERPDataCollectorNDB_TEST';
	let db: LocationDb;
	let manifest: Map<PhyTable, ManifestEntry>;

	it('parses the InitPullTables response into a manifest', () => {
		manifest = manifestFor('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3');
		expect([...manifest.values()].map((e) => [e.originalTableName, e.rowsCount])).toEqual([
			['phyHeader', 1],
			['phyDetails', 102],
			['phyBarcodes', 0],
		]);
	});

	it('creates the schema in a fresh database', async () => {
		db = freshDb(fileName);
		openDbs.push(db);
		await db.ensureSchema();
		expect(await db.count('phyDetails')).toBe(0);
		expect(await db.count('stg_phyDetails')).toBe(0);
	});

	it('inserts every page with bound parameters', async () => {
		const header = entryOf(manifest, 'phyHeader');
		const details = entryOf(manifest, 'phyDetails');
		const barcodes = entryOf(manifest, 'phyBarcodes');

		expect(await db.insertPage('phyHeader', pageRows(header, sample('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml')))).toEqual({ inserted: 1, skipped: 0 });
		for (const [page, expected] of [
			['from1', 50],
			['from51', 50],
			['from101', 2],
			['from103-past-end', 0],
		] as const) {
			const result = await db.insertPage('phyDetails', pageRows(details, sample(`pullRecords.count9-V2-UN3.phyDetails.${page}.response.xml`)));
			expect(result).toEqual({ inserted: expected, skipped: 0 });
		}
		expect(pageRows(barcodes, sample('pullRecords.count9-V2-UN3.phyBarcodes.empty.response.xml'))).toEqual([]);

		expect(await db.count('phyHeader')).toBe(1);
		expect(await db.count('phyDetails')).toBe(102);
		expect(await db.count('phyBarcodes')).toBe(0);
	});

	it('stores the header and details as the service sent them', async () => {
		const [header] = await db.selectAll('phyHeader');
		expect([header.InvID, header.UserToUpdate, header.SP_DecNo, header.SP_Expiry, header.Warehouse]).toEqual(['9', '4', '3', 'Y', 'wh1']);

		const details = await db.selectAll('phyDetails');
		expect(details.map((d) => d.RowNumber)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
		expect(details.map((d) => d._id)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
		const first = details[0];
		expect([first.Pcd_RecId, first.Refernce, first.stk_Desc, first.exp, first.Pcd_Batch, first.usercounted, first.updated]).toEqual([
			'47842',
			'N/PD/SEL/1/N',
			'JELLY BOXES TAZAH CHERRY 85G',
			'01.01.2025',
			'J16-3135',
			'0.000',
			'0',
		]);
	});

	it('skips rows already stored when a page is received again (resume)', async () => {
		const rows = pageRows(entryOf(manifest, 'phyDetails'), sample('pullRecords.count9-V2-UN3.phyDetails.from51.response.xml'));
		expect(await db.insertPage('phyDetails', rows)).toEqual({ inserted: 0, skipped: 50 });
		expect(await db.count('phyDetails')).toBe(102);
	});

	it('rolls back the whole page when one row fails', async () => {
		const [template] = pageRows(entryOf(manifest, 'phyDetails'), sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'));
		const withRecId = (rowNumber: number, recId: string): PageRow => {
			const values = [...template.values];
			values[0] = String(rowNumber);
			values[COLUMNS.phyDetails.indexOf('Pcd_RecId')] = recId;
			return { rowNumber, values };
		};
		// Row 200 is new; row 201 repeats Pcd_RecId 47842, which the unique index refuses.
		await expect(db.insertPage('phyDetails', [withRecId(200, '999000001'), withRecId(201, '47842')])).rejects.toThrow();
		expect(await db.count('phyDetails')).toBe(102);
		expect((await db.selectAll('phyDetails')).some((d) => d.RowNumber === 200)).toBe(false);
	});

	it('rejects a corrupted valuesquery before anything is stored', () => {
		const details = entryOf(manifest, 'phyDetails');
		expect(() => toPageRows(details.columnMap, ["'1','47842','V2'); DELETE FROM phyDetails; --"])).toThrow(ServiceDataError);
	});

	it('writes to the staging tables the same way', async () => {
		const rows = pageRows(entryOf(manifest, 'phyHeader'), sample('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml'));
		expect(await db.insertPage('phyHeader', rows, { staging: true })).toEqual({ inserted: 1, skipped: 0 });
		expect(await db.count('stg_phyHeader')).toBe(1);
	});

	it('keeps the data after closing and reopening the file', async () => {
		db.close();
		db = LocationDb.open(fileName);
		openDbs.push(db);
		await db.ensureSchema();
		expect(await db.count('phyDetails')).toBe(102);
	});
});

describe('spike: count 10 / CV / UN into ERPDataCollectorNDB_TEST10', () => {
	it('stores details and the barcodes, including the duplicate and the empty one', async () => {
		const manifest = manifestFor('InitPullTables.count10-CV-UN.response.xml', 'CV', 'UN');
		expect(entryOf(manifest, 'phyDetails').rowsCount).toBe(11131);
		const db = freshDb('ERPDataCollectorNDB_TEST10');
		openDbs.push(db);
		await db.ensureSchema();

		const details = pageRows(entryOf(manifest, 'phyDetails'), sample('pullRecords.count10-CV-UN.phyDetails.from1.response.xml'));
		expect(await db.insertPage('phyDetails', details)).toEqual({ inserted: 20, skipped: 0 });
		const barcodes = pageRows(entryOf(manifest, 'phyBarcodes'), sample('pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml'));
		expect(await db.insertPage('phyBarcodes', barcodes)).toEqual({ inserted: 9, skipped: 0 });

		const stored = await db.selectAll('phyBarcodes');
		const duplicate = stored.filter((b) => b.PcBarc_Barcode === '2000000000848');
		expect(duplicate.map((b) => b.PcBarc_DRecId)).toEqual(['40767', '36341']);
		expect(stored.filter((b) => b.PcBarc_Barcode === '')).toHaveLength(1);
		expect(field('phyBarcodes', barcodes[0], 'PcBarc_Barcode')).toBe('5285002192105');
	});
});

describe('spike: location database file name', () => {
	it('keeps the location code exactly as typed', () => {
		expect(locationDbFileName('V2')).toBe('ERPDataCollectorNDB_V2');
		expect(locationDbFileName('v2')).toBe('ERPDataCollectorNDB_v2');
		expect(() => locationDbFileName('V2;')).toThrow();
		expect(() => locationDbFileName('ABC')).toThrow();
	});
});

describe('spike: timing for a count-10-sized download (11,131 detail rows)', () => {
	it('parses and inserts 11,131 rows in 5000-row pages', async () => {
		const TOTAL = 11131;
		const PAGE_SIZE = 5000;
		const manifest = manifestFor('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3');
		const details = entryOf(manifest, 'phyDetails');
		const template = readPullRecords(sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'));
		if (template.kind !== 'records') throw new Error('expected records');
		const rest = template.valuesQueries[0].split(',').slice(2).join(',');

		const db = freshDb('ERPDataCollectorNDB_PERF');
		openDbs.push(db);
		await db.ensureSchema();

		const timings: string[] = [];
		for (let start = 1; start <= TOTAL; start += PAGE_SIZE) {
			const end = Math.min(start + PAGE_SIZE - 1, TOTAL);
			const records: string[] = [];
			for (let n = start; n <= end; n++) records.push(`<Record><valuesquery>'${n}','${100000000 + n}',${rest}</valuesquery></Record>`);
			const xml =
				'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
				`<pullRecordsResponse xmlns="http://tempuri.org/"><pullRecordsResult><mRecords>${records.join('')}</mRecords></pullRecordsResult></pullRecordsResponse>` +
				'</soap:Body></soap:Envelope>';

			const t0 = Date.now();
			const rows = pageRows(details, xml);
			const t1 = Date.now();
			const result = await db.insertPage('phyDetails', rows);
			const t2 = Date.now();
			expect(result.inserted).toBe(end - start + 1);
			timings.push(`rows ${start}-${end} (${(xml.length / 1024).toFixed(0)} KB): parse ${t1 - t0} ms, insert ${t2 - t1} ms`);
		}
		expect(await db.count('phyDetails')).toBe(TOTAL);
		console.log(`[spike timing]\n${timings.join('\n')}`);
	});
});
