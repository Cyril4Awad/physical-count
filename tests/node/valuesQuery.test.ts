import { describe, expect, it } from 'vitest';
import { ServiceDataError } from '../../src/parse/errors';
import { MAX_VALUE_LENGTH, tokenizeValuesQuery } from '../../src/parse/valuesQuery';

describe('tokenizeValuesQuery', () => {
	it('splits the documented phyDetails row', () => {
		const row =
			"'1','47842','V2','992','N/PD/SEL/1/N','JELLY BOXES TAZAH CHERRY 85G','','','','','01.01.2025','J16-3135','Dec 31 2022 12:00AM','0','','','','','','','','','','','','','0.000','0'";
		const values = tokenizeValuesQuery(row);
		expect(values).toHaveLength(28);
		expect(values[1]).toBe('47842');
		expect(values[4]).toBe('N/PD/SEL/1/N');
		expect(values[12]).toBe('Dec 31 2022 12:00AM');
		expect(values[26]).toBe('0.000');
	});

	it('keeps commas, parentheses and Unicode inside quotes', () => {
		expect(tokenizeValuesQuery("'a,b','(x) values (y)','حليب 1L','é'")).toEqual(['a,b', '(x) values (y)', 'حليب 1L', 'é']);
	});

	it('keeps empty values and a single value', () => {
		expect(tokenizeValuesQuery("'','',''")).toEqual(['', '', '']);
		expect(tokenizeValuesQuery("'7'")).toEqual(['7']);
	});

	it('ignores whitespace outside quotes but keeps it inside', () => {
		expect(tokenizeValuesQuery("  ' a ' ,\t'b'  ")).toEqual([' a ', 'b']);
	});

	it.each([
		['empty string', ''],
		['only whitespace', '   '],
		['unquoted token', "'1',2,'3'"],
		['NULL keyword', "'1',NULL"],
		['unterminated quote', "'1','abc"],
		['stray text after a value', "'1'x,'2'"],
		['trailing comma', "'1','2',"],
		['leading comma', ",'1'"],
		['a quote inside a value', "'it's'"],
		['SQL after the values', "'1'); DROP TABLE phyDetails; --"],
	])('rejects %s', (_label, text) => {
		expect(() => tokenizeValuesQuery(text)).toThrow(ServiceDataError);
	});

	it('rejects a value longer than the staging column', () => {
		expect(tokenizeValuesQuery(`'${'x'.repeat(MAX_VALUE_LENGTH)}'`)[0]).toHaveLength(MAX_VALUE_LENGTH);
		expect(() => tokenizeValuesQuery(`'${'x'.repeat(MAX_VALUE_LENGTH + 1)}'`)).toThrow(ServiceDataError);
	});
});
