import { describe, expect, it } from 'vitest';
import {
	allowedDecimals,
	checkQuantity,
	checkUploadQuantity,
	decimalsUsed,
	formatForUpload,
	formatQuantity,
	formatStoredQuantity,
	MAX_QUANTITY,
	parseStoredQuantity,
	parseTypedQuantity,
} from '../../src/domain/decimal';

describe('allowedDecimals (SP_DecNo, capped at 3)', () => {
	it.each([
		['0', 0],
		['1', 1],
		['2', 2],
		['3', 3],
		['4', 3],
		['10', 3],
		['', 0],
		['x', 0],
		[' 2 ', 2],
	])('SP_DecNo "%s" → %i', (text, decimals) => expect(allowedDecimals(text)).toBe(decimals));
});

describe('parseStoredQuantity (values from the service)', () => {
	it.each([
		['0.000', 0n],
		['7.000', 7000n],
		['12.5', 12500n],
		['0.125', 125n],
		['10000', 10_000_000n],
		['', 0n],
		['-2.000', -2000n],
		['99999999999999.999', MAX_QUANTITY],
	])('"%s" → %s', (text, value) => expect(parseStoredQuantity(text)).toBe(value));
	it.each(['abc', '1.0E7', '1,5', '1.2345', '12.'])('rejects "%s"', (text) => expect(parseStoredQuantity(text)).toBeNull());
});

describe('parseTypedQuantity (fields on the Scan screen)', () => {
	it('has no length lock: 10000 and above are fine (D5)', () => {
		expect(parseTypedQuantity('10000', 0)).toEqual({ ok: true, value: 10_000_000n });
		expect(parseTypedQuantity('10000.0', 0)).toEqual({ ok: true, value: 10_000_000n });
		expect(parseTypedQuantity('1234567', 0)).toEqual({ ok: true, value: 1_234_567_000n });
	});
	it('accepts decimals up to SP_DecNo, with a dot or a comma', () => {
		expect(parseTypedQuantity('2.5', 1)).toEqual({ ok: true, value: 2500n });
		expect(parseTypedQuantity('2,25', 2)).toEqual({ ok: true, value: 2250n });
		expect(parseTypedQuantity('0.125', 3)).toEqual({ ok: true, value: 125n });
		expect(parseTypedQuantity('.5', 1)).toEqual({ ok: true, value: 500n });
		expect(parseTypedQuantity('5.', 0)).toEqual({ ok: true, value: 5000n });
		expect(parseTypedQuantity('007', 0)).toEqual({ ok: true, value: 7000n });
		expect(parseTypedQuantity('3.500', 1)).toEqual({ ok: true, value: 3500n });
	});
	it.each([
		['', 0, 'Enter a quantity.'],
		['2.5', 0, 'Whole numbers only.'],
		['2.25', 1, 'At most 1 decimal.'],
		['0.0001', 3, 'At most 3 decimals.'],
		['-1', 3, 'The quantity cannot be negative.'],
		['1e5', 0, 'Not a number.'],
		['1,000.5', 3, 'Not a number.'],
		['abc', 0, 'Not a number.'],
		['.', 0, 'Not a number.'],
		['+1', 0, 'Not a number.'],
		['100000000000000', 0, 'The quantity is too large.'],
	])('"%s" with %i decimals → %s', (text, decimals, message) => {
		expect(parseTypedQuantity(text, decimals)).toEqual({ ok: false, message });
	});
	it('accepts exactly the cap', () => {
		expect(parseTypedQuantity('99999999999999.999', 3)).toEqual({ ok: true, value: MAX_QUANTITY });
	});
});

describe('checkQuantity', () => {
	it('checks sign, cap and decimals', () => {
		expect(checkQuantity(0n, 0).ok).toBe(true);
		expect(checkQuantity(-1n, 3).ok).toBe(false);
		expect(checkQuantity(MAX_QUANTITY + 1n, 3).ok).toBe(false);
		expect(checkQuantity(1500n, 0).ok).toBe(false);
		expect(checkQuantity(1500n, 1).ok).toBe(true);
	});
	it('checks upload values with up to 3 decimals regardless of SP_DecNo (Q14)', () => {
		expect(checkUploadQuantity(7500n)).toEqual({ ok: true, value: 7500n });
		expect(checkUploadQuantity(125n)).toEqual({ ok: true, value: 125n });
		expect(checkUploadQuantity(-1n).ok).toBe(false);
		expect(checkUploadQuantity(MAX_QUANTITY + 1n).ok).toBe(false);
	});
	it('counts decimals used', () => {
		expect([0n, 1000n, 1500n, 1250n, 1125n, -1250n].map(decimalsUsed)).toEqual([0, 0, 1, 2, 3, 2]);
	});
});

describe('formatting', () => {
	it.each([
		[0n, '0', '0.0'],
		[12_000n, '12', '12.0'],
		[12_500n, '12.5', '12.5'],
		[125n, '0.125', '0.125'],
		[10_000_000n, '10000', '10000.0'],
		[10_000_000_000n, '10000000', '10000000.0'],
		[-2_000n, '-2', '-2.0'],
		[MAX_QUANTITY, '99999999999999.999', '99999999999999.999'],
	])('%s → display "%s", upload "%s"', (value, display, upload) => {
		expect(formatQuantity(value)).toBe(display);
		expect(formatForUpload(value)).toBe(upload);
	});
	it.each([
		[0n, '0.000'],
		[8500n, '8.500'],
		[125n, '0.125'],
		[10_000_000n, '10000.000'],
		[-2000n, '-2.000'],
	])('stores %s as "%s" and reads it back', (value, text) => {
		expect(formatStoredQuantity(value)).toBe(text);
		expect(parseStoredQuantity(text)).toBe(value);
	});
	it('never drifts like floating point', () => {
		const sum = parseTypedQuantity('0.1', 1).ok && parseTypedQuantity('0.2', 1);
		expect(sum && sum.ok && formatQuantity(100n + sum.value)).toBe('0.3');
	});
});
