import { describe, expect, it } from 'vitest';
import {
	checkCountNumber,
	checkLocationCode,
	checkMachineName,
	checkPageSize,
	checkPcdRecId,
	checkServerAddress,
	checkTransCount,
	checkUserToUpdate,
	DEFAULT_PAGE_SIZE,
} from '../../src/domain/validation';

const ok = <T>(value: T) => ({ ok: true, value });

describe('location code', () => {
	it.each(['V2', 'CV', 'v2', '1', 'A'])('accepts %s exactly as typed', (code) => {
		expect(checkLocationCode(code)).toEqual(ok(code));
	});
	it.each(['', 'V22', ' V2', 'V2 ', "V'", 'V-', 'é1'])('rejects "%s"', (code) => {
		expect(checkLocationCode(code).ok).toBe(false);
	});
});

describe('machine name', () => {
	it.each(['UN', 'UN3', 'HH001', 'a'])('accepts %s', (name) => {
		expect(checkMachineName(name)).toEqual(ok(name));
	});
	it.each(['', 'HH0001', 'UN 3', "UN'", 'UN-3'])('rejects "%s"', (name) => {
		expect(checkMachineName(name).ok).toBe(false);
	});
});

describe('server address (format only; any host)', () => {
	it.each(['192.168.1.10', '192.168.1.10:8080', 'erp-server', 'erp-server.local:80', 'localhost', '10.0.2.2:5000', 'ERP01'])('accepts %s', (address) => {
		expect(checkServerAddress(address)).toEqual(ok(address));
	});
	it.each([
		['empty', ''],
		['with http://', 'http://192.168.1.10'],
		['with https://', 'https://erp'],
		['with a path', '192.168.1.10/ERPDataCollector'],
		['with a space', 'erp server'],
		['port 0', 'erp:0'],
		['port 65536', 'erp:65536'],
		['an empty port', 'erp:'],
		['a double dot', 'erp..local'],
		['a leading dot', '.erp'],
		['a label starting with a dash', '-erp'],
		['an underscore', 'erp_1'],
		['a quote', "erp'"],
	])('rejects %s', (_label, address) => {
		expect(checkServerAddress(address).ok).toBe(false);
	});
	it('explains the http:// mistake', () => {
		const result = checkServerAddress('http://erp');
		expect(result.ok === false && result.message).toContain('without http://');
	});
});

describe('count number, line id, slot, transCount', () => {
	it('trims and accepts digits for the count number', () => {
		expect(checkCountNumber(' 1234 ')).toEqual(ok('1234'));
		expect(checkCountNumber('1'.repeat(18))).toEqual(ok('1'.repeat(18)));
	});
	it.each(['', '12a', '-5', '1.5', '1'.repeat(19), '9 OR 1=1'])('rejects count number "%s"', (text) => {
		expect(checkCountNumber(text).ok).toBe(false);
	});
	it('accepts only digits for Pcd_RecId', () => {
		expect(checkPcdRecId('47842')).toEqual(ok('47842'));
		expect(checkPcdRecId('47842 ').ok).toBe(false);
		expect(checkPcdRecId('').ok).toBe(false);
	});
	it.each(['1', '6'])('accepts slot %s', (slot) => expect(checkUserToUpdate(slot)).toEqual(ok(slot)));
	it.each(['0', '7', '', '11', ' 1'])('rejects slot "%s"', (slot) => expect(checkUserToUpdate(slot).ok).toBe(false));
	it('accepts transCount from 1', () => {
		expect(checkTransCount(1)).toEqual(ok(1));
		expect(checkTransCount(0).ok).toBe(false);
		expect(checkTransCount(1.5).ok).toBe(false);
	});
});

describe('download page size', () => {
	it('defaults to 1000', () => expect(DEFAULT_PAGE_SIZE).toBe(1000));
	it.each([
		['1', 1],
		['1000', 1000],
		[' 5000 ', 5000],
	])('accepts "%s"', (text, value) => expect(checkPageSize(text)).toEqual(ok(value)));
	it.each(['', '0', '5001', '12.5', '-1', 'abc', '10000'])('rejects "%s" instead of crashing', (text) => {
		expect(checkPageSize(text).ok).toBe(false);
	});
});
