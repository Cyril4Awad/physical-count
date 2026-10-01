import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../src/domain/check';
import {
	buildInitPullTables,
	buildInsertDetail,
	buildPullRecords,
	escapeXml,
	formatDeviceInfo,
	serviceUrl,
	soapAction,
} from '../../src/soap/envelopes';

const SAMPLES_DIR = join(__dirname, '..', '..', 'docs', 'service-samples');
const bytes = (name: string) => readFileSync(join(SAMPLES_DIR, name));
const built = (xml: string) => Buffer.from(xml, 'utf8');

const deviceInfo = formatDeviceInfo({ model: 'rebuild-test', manufacturer: 'local', brand: 'local' });

const INIT_PULL_TABLES: [string, { location: string; machine: string; countNumber: string }][] = [
	['InitPullTables.count9-V2-UN3.request.xml', { location: 'V2', machine: 'UN3', countNumber: '9' }],
	['InitPullTables.count10-CV-UN.request.xml', { location: 'CV', machine: 'UN', countNumber: '10' }],
	['InitPullTables.count999999-not-found.request.xml', { location: 'V2', machine: 'UN3', countNumber: '999999' }],
	['InitPullTables.count9-V2-machine-not-assigned.request.xml', { location: 'V2', machine: 'ZZ9', countNumber: '9' }],
];

const PULL_RECORDS: [string, { tableName: string; pageSize: number; startFromRow: number }][] = [
	['pullRecords.count9-V2-UN3.phyHeader.from1.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountHeader_V2UN3', pageSize: 5000, startFromRow: 1 }],
	['pullRecords.count9-V2-UN3.phyDetails.from1.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 50, startFromRow: 1 }],
	['pullRecords.count9-V2-UN3.phyDetails.from51.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 50, startFromRow: 51 }],
	['pullRecords.count9-V2-UN3.phyDetails.from101.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 50, startFromRow: 101 }],
	['pullRecords.count9-V2-UN3.phyDetails.from103-past-end.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 50, startFromRow: 103 }],
	['pullRecords.count9-V2-UN3.phyBarcodes.empty.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetBarcode_V2UN3', pageSize: 5000, startFromRow: 1 }],
	['pullRecords.count10-CV-UN.phyDetails.from1.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_CVUN', pageSize: 20, startFromRow: 1 }],
	['pullRecords.count10-CV-UN.phyBarcodes.from1.request.xml', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetBarcode_CVUN', pageSize: 5000, startFromRow: 1 }],
];

const INSERT_DETAIL_BASE = { location: 'V2', invId: '9', localId: 1, pcdRecId: '47842', userToUpdate: '4' };
const INSERT_DETAIL: [string, { transCount: number; counted: bigint }][] = [
	['InsertDetail.count9-V2-slot4.send5.request.xml', { transCount: 1, counted: 5000n }],
	['InsertDetail.count9-V2-slot4.send7.request.xml', { transCount: 2, counted: 7000n }],
];

describe('request builders match the saved samples byte for byte', () => {
	it('covers every saved request sample', () => {
		const names = readdirSync(SAMPLES_DIR).filter((n) => n.endsWith('.request.xml')).sort();
		const covered = [...INIT_PULL_TABLES, ...PULL_RECORDS, ...INSERT_DETAIL].map(([name]) => name).sort();
		expect(covered).toEqual(names);
	});

	it.each(INIT_PULL_TABLES)('%s', (name, request) => {
		expect(built(buildInitPullTables({ ...request, deviceInfo }))).toEqual(bytes(name));
	});

	it.each(PULL_RECORDS)('%s', (name, request) => {
		expect(built(buildPullRecords(request))).toEqual(bytes(name));
	});

	it.each(INSERT_DETAIL)('%s', (name, request) => {
		expect(built(buildInsertDetail({ ...INSERT_DETAIL_BASE, ...request }))).toEqual(bytes(name));
	});
});

describe('request builders refuse unchecked values (§3.7)', () => {
	const init = { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo };

	it.each([
		['a location with a quote', { ...init, location: "V'" }],
		['a 3-character location', { ...init, location: 'V22' }],
		['a 6-character machine name', { ...init, machine: 'UN3456' }],
		['a machine name with SQL', { ...init, machine: "a' OR '1'='1" }],
		['a count number with letters', { ...init, countNumber: '9 OR 1=1' }],
		['an empty count number', { ...init, countNumber: '' }],
	])('InitPullTables: %s', (_label, request) => {
		expect(() => buildInitPullTables(request)).toThrow(InvalidInputError);
	});

	it.each([
		['a foreign table name', { tableName: 'sysobjects', pageSize: 1000, startFromRow: 1 }],
		['a table name with SQL', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3; DROP TABLE x', pageSize: 1000, startFromRow: 1 }],
		['page size 0', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 0, startFromRow: 1 }],
		['page size 5001', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 5001, startFromRow: 1 }],
		['start row 0', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 1000, startFromRow: 0 }],
		['a fractional start row', { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 1000, startFromRow: 1.5 }],
	])('pullRecords: %s', (_label, request) => {
		expect(() => buildPullRecords(request)).toThrow(InvalidInputError);
	});

	const insert = { ...INSERT_DETAIL_BASE, transCount: 1, counted: 5000n };
	it.each([
		['transCount 0', { ...insert, transCount: 0 }],
		['a negative quantity (S19)', { ...insert, counted: -1000n }],
		['a quantity above the cap (S19)', { ...insert, counted: 100_000_000_000_000_000n }],
		['slot 7', { ...insert, userToUpdate: '7' }],
		['a line id with SQL', { ...insert, pcdRecId: "47842' OR '1'='1" }],
		['a count number with letters', { ...insert, invId: '9a' }],
		['local id 0', { ...insert, localId: 0 }],
	])('InsertDetail: %s', (_label, request) => {
		expect(() => buildInsertDetail(request)).toThrow(InvalidInputError);
	});

	it('InsertDetail accepts up to 3 decimals whatever SP_DecNo is (Q14)', () => {
		expect(buildInsertDetail({ ...insert, counted: 8500n })).toContain('<usercounted>8.5</usercounted>');
		expect(buildInsertDetail({ ...insert, counted: 8125n })).toContain('<usercounted>8.125</usercounted>');
	});

	it('InsertDetail sends the cap and 3 decimals as plain decimals', () => {
		expect(buildInsertDetail({ ...insert, counted: 99_999_999_999_999_999n })).toContain('<usercounted>99999999999999.999</usercounted>');
		expect(buildInsertDetail({ ...insert, counted: 12_500n })).toContain('<usercounted>12.5</usercounted>');
		expect(buildInsertDetail({ ...insert, counted: 10_000_000_000n })).toContain('<usercounted>10000000.0</usercounted>');
	});
});

describe('SOAP helpers', () => {
	it('builds the service URL and SOAPAction', () => {
		expect(serviceUrl('192.168.1.10')).toBe('http://192.168.1.10/ERPDataCollector/Service1.asmx');
		expect(serviceUrl('erp-v2:8080')).toBe('http://erp-v2:8080/ERPDataCollector/Service1.asmx');
		expect(() => serviceUrl('http://erp')).toThrow(InvalidInputError);
		expect(soapAction('InsertDetail')).toBe('http://tempuri.org/InsertDetail');
	});

	it('escapes XML special characters', () => {
		expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
	});

	it('cleans device strings for DeviceInfo', () => {
		const text = formatDeviceInfo({ model: 'NLS-MT90\u0000', manufacturer: 'Newland\r\nX', brand: 'Newland' });
		expect(text).toBe('Device Model: NLS-MT90\nDevice Manufacturer: Newland  X\nDevice Brand: Newland\n');
		expect(buildInitPullTables({ location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo: 'A&B <c>' })).toContain('<DeviceInfo>A&amp;B &lt;c&gt;</DeviceInfo>');
	});
});
