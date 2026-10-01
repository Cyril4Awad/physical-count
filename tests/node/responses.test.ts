import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceDataError } from '../../src/parse/errors';
import { readInitPullTables, readInsertDetail, readPullRecords, SoapFaultError } from '../../src/soap/responses';
import { envelope, pullRecordsResponse, sample } from './samples';

describe('readInitPullTables', () => {
	it('reads count 9 / V2 / UN3: three tables', () => {
		const result = readInitPullTables(sample('InitPullTables.count9-V2-UN3.response.xml'));
		expect(result.kind).toBe('tables');
		if (result.kind !== 'tables') return;
		expect(result.tables.map((t) => [t.OriginalTableName, t.RowsCount])).toEqual([
			['phyHeader', '1'],
			['phyDetails', '102'],
			['phyBarcodes', '0'],
		]);
		expect(result.tables[0].TableName).toBe('_ERPDATACOLLECTOR_tbl_PhysicalCountHeader_V2UN3');
		expect(result.tables[0].SelectedLocation).toBe('V2');
		expect(result.tables[0].MachineName).toBe('UN3');
		expect(result.tables[0].Notes).toBe('');
	});

	it('reads count 10 / CV / UN', () => {
		const result = readInitPullTables(sample('InitPullTables.count10-CV-UN.response.xml'));
		if (result.kind !== 'tables') throw new Error('expected tables');
		expect(result.tables.map((t) => t.RowsCount)).toEqual(['1', '11131', '9']);
	});

	it.each(['InitPullTables.count999999-not-found.response.xml', 'InitPullTables.count9-V2-machine-not-assigned.response.xml'])(
		'reads %s as a single header table with RowsCount 0',
		(name) => {
			const result = readInitPullTables(sample(name));
			if (result.kind !== 'tables') throw new Error('expected tables');
			expect(result.tables).toHaveLength(1);
			expect(result.tables[0].OriginalTableName).toBe('phyHeader');
			expect(result.tables[0].RowsCount).toBe('0');
		},
	);

	it('reports noResults when mTableInfo is missing', () => {
		expect(readInitPullTables(envelope('<InitPullTablesResponse xmlns="http://tempuri.org/"><InitPullTablesResult /></InitPullTablesResponse>'))).toEqual({
			kind: 'noResults',
		});
	});

	it('rejects a TableInfo without a required field', () => {
		const xml = envelope(
			'<InitPullTablesResponse xmlns="http://tempuri.org/"><InitPullTablesResult><mTableInfo><TableInfo><TableName>x</TableName></TableInfo></mTableInfo></InitPullTablesResult></InitPullTablesResponse>',
		);
		expect(() => readInitPullTables(xml)).toThrow(ServiceDataError);
	});
});

describe('readPullRecords', () => {
	it('reads the count 9 header page', () => {
		const result = readPullRecords(sample('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml'));
		expect(result).toEqual({
			kind: 'records',
			valuesQueries: ["'1','9','wh1','31/12/2022','UN','UN1','UN2','UN3','','','N','N','27','4','3','N','Y','0','9'"],
		});
	});

	it.each([
		['pullRecords.count9-V2-UN3.phyDetails.from1.response.xml', 50],
		['pullRecords.count9-V2-UN3.phyDetails.from51.response.xml', 50],
		['pullRecords.count9-V2-UN3.phyDetails.from101.response.xml', 2],
		['pullRecords.count10-CV-UN.phyDetails.from1.response.xml', 20],
		['pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml', 9],
	])('reads %s (%i records)', (name, count) => {
		const result = readPullRecords(sample(name));
		if (result.kind !== 'records') throw new Error('expected records');
		expect(result.valuesQueries).toHaveLength(count);
	});

	it.each(['pullRecords.count9-V2-UN3.phyDetails.from103-past-end.response.xml', 'pullRecords.count9-V2-UN3.phyBarcodes.empty.response.xml'])(
		'reads %s as noResults',
		(name) => {
			expect(readPullRecords(sample(name))).toEqual({ kind: 'noResults' });
		},
	);

	it('keeps a single record as a list', () => {
		const result = readPullRecords(pullRecordsResponse(["'1'"]));
		expect(result).toEqual({ kind: 'records', valuesQueries: ["'1'"] });
	});

	it('decodes XML entities and numeric character references, and keeps numbers as text', () => {
		const result = readPullRecords(pullRecordsResponse(["'A&amp;B','&lt;5&gt;','caf&#233; &#xE9;','5285002192105','0.000'"]));
		expect(result).toEqual({ kind: 'records', valuesQueries: ["'A&B','<5>','café é','5285002192105','0.000'"] });
	});

	it('rejects a Record without valuesquery', () => {
		const xml = envelope('<pullRecordsResponse xmlns="http://tempuri.org/"><pullRecordsResult><mRecords><Record /></mRecords></pullRecordsResult></pullRecordsResponse>');
		expect(() => readPullRecords(xml)).toThrow(ServiceDataError);
	});
});

describe('readInsertDetail', () => {
	it.each(['InsertDetail.count9-V2-slot4.send5.response.xml', 'InsertDetail.count9-V2-slot4.send7.response.xml'])('reads ok from %s', (name) => {
		expect(readInsertDetail(sample(name))).toBe('ok');
	});

	it('returns an error text as is', () => {
		const xml = envelope('<InsertDetailResponse xmlns="http://tempuri.org/"><InsertDetailResult>This Physical Count Was Cancelled</InsertDetailResult></InsertDetailResponse>');
		expect(readInsertDetail(xml)).toBe('This Physical Count Was Cancelled');
	});
});

describe('any response', () => {
	it('turns a SOAP Fault into SoapFaultError', () => {
		const xml = envelope('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Server was unable to read request.</faultstring></soap:Fault>');
		expect(() => readPullRecords(xml)).toThrow(SoapFaultError);
		expect(() => readPullRecords(xml)).toThrow('Server was unable to read request.');
	});

	it.each([
		['not XML', 'Service Unavailable'],
		['an HTML error page', '<html><body><h1>Server Error</h1><br></body></html>'],
		['a truncated body', sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml').slice(0, 2000)],
		['the wrong response element', sample('InsertDetail.count9-V2-slot4.send5.response.xml')],
	])('rejects %s', (_label, xml) => {
		expect(() => readPullRecords(xml)).toThrow(ServiceDataError);
	});

	it('parses every saved response sample without error', () => {
		const dir = join(__dirname, '..', '..', 'docs', 'service-samples');
		const names = readdirSync(dir).filter((n) => n.endsWith('.response.xml'));
		expect(names.length).toBe(14);
		for (const name of names) {
			const xml = sample(name);
			if (name.startsWith('InitPullTables.')) readInitPullTables(xml);
			else if (name.startsWith('pullRecords.')) readPullRecords(xml);
			else readInsertDetail(xml);
		}
	});
});
