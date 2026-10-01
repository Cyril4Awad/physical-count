import { describe, expect, it } from 'vitest';
import { ServiceDataError } from '../../src/parse/errors';
import { buildManifest, isExpectedTableName } from '../../src/parse/manifest';
import { mapColumns, toPageRows } from '../../src/parse/rows';
import { readInitPullTables, readPullRecords, TableInfo } from '../../src/soap/responses';
import { COLUMNS } from '../../src/storage/schema';
import { sample } from './samples';

function tables(name: string): TableInfo[] {
	const result = readInitPullTables(sample(name));
	if (result.kind !== 'tables') throw new Error('expected tables');
	return result.tables;
}

function records(name: string): string[] {
	const result = readPullRecords(sample(name));
	if (result.kind !== 'records') throw new Error('expected records');
	return result.valuesQueries;
}

describe('buildManifest', () => {
	it('builds the count 9 manifest', () => {
		const result = buildManifest(tables('InitPullTables.count9-V2-UN3.response.xml'), 'V2', 'UN3');
		if (result.kind !== 'ok') throw new Error('expected ok');
		expect(result.entries.map((e) => [e.originalTableName, e.rowsCount, e.displayHeader])).toEqual([
			['phyHeader', 1, 'Synchronizing Physical Count Header'],
			['phyDetails', 102, 'Synchronizing Details'],
			['phyBarcodes', 0, 'Synchronizing Barcodes'],
		]);
		expect(result.entries[1].columns).toEqual(COLUMNS.phyDetails);
	});

	it.each(['InitPullTables.count999999-not-found.response.xml', 'InitPullTables.count9-V2-machine-not-assigned.response.xml'])(
		'reports %s as not downloadable',
		(name) => {
			const result = buildManifest(tables(name), 'V2', name.includes('machine-not-assigned') ? 'ZZ9' : 'UN3');
			expect(result).toEqual({ kind: 'notDownloadable', reason: 'notFound' });
		},
	);

	it('ignores tables echoed for another location or machine (legacy filter)', () => {
		const infos = tables('InitPullTables.count9-V2-UN3.response.xml');
		expect(buildManifest(infos, 'V2', 'UN4')).toEqual({ kind: 'notDownloadable', reason: 'notFound' });
		expect(buildManifest(infos, 'v2', 'UN3')).toEqual({ kind: 'notDownloadable', reason: 'notFound' });
	});

	it('a phyDetails entry with 0 rows means the count has no lines, not an incomplete answer', () => {
		const infos = tables('InitPullTables.count9-V2-UN3.response.xml');
		infos[1] = { ...infos[1], RowsCount: '0' };
		expect(buildManifest(infos, 'V2', 'UN3')).toEqual({ kind: 'notDownloadable', reason: 'noLines' });
		// Without a phyDetails entry at all, it is the incomplete case.
		expect(buildManifest(infos.filter((t) => t.OriginalTableName !== 'phyDetails'), 'V2', 'UN3')).toEqual({ kind: 'notDownloadable', reason: 'incomplete' });
		// phyBarcodes with 0 rows is normal (count 9 has none).
		expect(buildManifest(tables('InitPullTables.count9-V2-UN3.response.xml'), 'V2', 'UN3').kind).toBe('ok');
	});

	it('header found but no details table: the server failed while preparing the lines (step 6)', () => {
		const infos = tables('InitPullTables.count9-V2-UN3.response.xml').slice(0, 1);
		expect(infos[0].RowsCount).toBe('1');
		expect(buildManifest(infos, 'V2', 'UN3')).toEqual({ kind: 'notDownloadable', reason: 'incomplete' });
	});

	it('rejects a TableName that does not belong to this location + machine', () => {
		const infos = tables('InitPullTables.count9-V2-UN3.response.xml');
		infos[1] = { ...infos[1], TableName: "_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3; DROP TABLE x --" };
		expect(() => buildManifest(infos, 'V2', 'UN3')).toThrow(ServiceDataError);
	});

	it('rejects a changed column layout', () => {
		const infos = tables('InitPullTables.count9-V2-UN3.response.xml');
		infos[2] = { ...infos[2], InsertInto: 'Insert Into phyBarcodes(RowNumber,PcBarc_RecId,PcBarc_DRecId,PcBarc_Barcode,updated,Extra) Values' };
		expect(() => buildManifest(infos, 'V2', 'UN3')).toThrow("table layout has changed");
	});

	it('checks table names per kind, case-insensitively', () => {
		expect(isExpectedTableName('_ERPDATACOLLECTOR_tbl_PhysicalCountDetBarcode_CVUN', 'phyBarcodes', 'CV', 'UN')).toBe(true);
		expect(isExpectedTableName('_erpdatacollector_tbl_physicalcountheader_cvun', 'phyHeader', 'CV', 'UN')).toBe(true);
		expect(isExpectedTableName('_ERPDATACOLLECTOR_tbl_PhysicalCountHeader_CVUN', 'phyDetails', 'CV', 'UN')).toBe(false);
		expect(isExpectedTableName('_ERPDATACOLLECTOR_tbl_PhysicalCountHeader_CVUNX', 'phyHeader', 'CV', 'UN')).toBe(false);
	});
});

describe('mapColumns', () => {
	it('maps columns sent in another order and case', () => {
		const reversed = [...COLUMNS.phyBarcodes].reverse().map((c) => c.toUpperCase());
		expect(mapColumns('phyBarcodes', reversed).positions).toEqual([4, 3, 2, 1, 0]);
	});

	it.each([
		['a missing column', ['RowNumber', 'PcBarc_RecId', 'PcBarc_DRecId', 'PcBarc_Barcode']],
		['an extra column', [...COLUMNS.phyBarcodes, 'Extra']],
		['a duplicate column', [...COLUMNS.phyBarcodes.slice(0, 4), 'RowNumber']],
	])('rejects %s', (_label, columns) => {
		expect(() => mapColumns('phyBarcodes', columns)).toThrow(ServiceDataError);
	});
});

describe('toPageRows', () => {
	const detailsMap = mapColumns('phyDetails', COLUMNS.phyDetails);

	it('maps the count 9 header row', () => {
		const [row] = toPageRows(mapColumns('phyHeader', COLUMNS.phyHeader), records('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml'));
		const field = (name: string) => row.values[COLUMNS.phyHeader.indexOf(name)];
		expect(row.rowNumber).toBe(1);
		expect([field('InvID'), field('UserToUpdate'), field('SP_DecNo'), field('SP_Expiry'), field('Warehouse')]).toEqual(['9', '4', '3', 'Y', 'wh1']);
	});

	it('maps count 9 details page 1', () => {
		const rows = toPageRows(detailsMap, records('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'));
		expect(rows).toHaveLength(50);
		expect(rows.map((r) => r.rowNumber)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		const field = (name: string) => rows[0].values[COLUMNS.phyDetails.indexOf(name)];
		expect([field('Pcd_RecId'), field('Refernce'), field('exp'), field('Pcd_Batch'), field('usercounted'), field('updated')]).toEqual([
			'47842',
			'N/PD/SEL/1/N',
			'01.01.2025',
			'J16-3135',
			'0.000',
			'0',
		]);
	});

	it('sorts rows by RowNumber (the service has no ORDER BY)', () => {
		const page = records('pullRecords.count9-V2-UN3.phyDetails.from51.response.xml').reverse();
		const rows = toPageRows(detailsMap, page);
		expect(rows[0].rowNumber).toBe(51);
		expect(rows[49].rowNumber).toBe(100);
	});

	it('reads count 10 barcodes, including the empty and the duplicate barcode', () => {
		const rows = toPageRows(mapColumns('phyBarcodes', COLUMNS.phyBarcodes), records('pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml'));
		const barcodes = rows.map((r) => r.values[3]);
		expect(barcodes).toHaveLength(9);
		expect(barcodes).toContain('');
		expect(barcodes.filter((b) => b === '2000000000848')).toHaveLength(2);
	});

	it('trims barcodes', () => {
		const rows = toPageRows(mapColumns('phyBarcodes', COLUMNS.phyBarcodes), ["'1','35','43377',' 5285002192105 ','0'"]);
		expect(rows[0].values[3]).toBe('5285002192105');
	});

	it.each([
		['a wrong value count', "'1','2','3'"],
		['a non-numeric RowNumber', "'x','35','43377','5285002192105','0'"],
		['RowNumber 0', "'0','35','43377','5285002192105','0'"],
	])('rejects %s', (_label, row) => {
		expect(() => toPageRows(mapColumns('phyBarcodes', COLUMNS.phyBarcodes), [row])).toThrow(ServiceDataError);
	});

	it('rejects a page with the same RowNumber twice', () => {
		expect(() => toPageRows(mapColumns('phyBarcodes', COLUMNS.phyBarcodes), ["'1','35','1','a','0'", "'1','36','2','b','0'"])).toThrow(ServiceDataError);
	});

	it('rejects a non-numeric Pcd_RecId', () => {
		const [row] = records('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml');
		expect(() => toPageRows(detailsMap, [row.replace("'47842'", "'47842 OR 1=1'")])).toThrow('Pcd_RecId');
	});

	it('rejects a header whose UserToUpdate is not 1–6', () => {
		const [row] = records('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml');
		const bad = row.replace("'27','4','3'", "'27','7','3'");
		expect(() => toPageRows(mapColumns('phyHeader', COLUMNS.phyHeader), [bad])).toThrow('UserToUpdate');
	});
});
