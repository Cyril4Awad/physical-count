import { describe, expect, it } from 'vitest';
import { cancelLastScan, scan, updateLastScanQty, updateTotalScanned } from '../../src/domain/countRules';
import { MAX_QUANTITY } from '../../src/domain/decimal';

describe('scan (legacy: stored + 1)', () => {
	it('adds one and enables the last-scan controls', () => {
		expect(scan(0n)).toEqual({ ok: true, value: { total: 1000n, lastScanned: 1000n, lastScanEnabled: true } });
		expect(scan(7000n)).toEqual({ ok: true, value: { total: 8000n, lastScanned: 1000n, lastScanEnabled: true } });
	});
	it('keeps working at 10000 and beyond (D5)', () => {
		expect(scan(9_999_000n).ok && scan(9_999_000n)).toMatchObject({ value: { total: 10_000_000n } });
		expect(scan(10_000_000n)).toMatchObject({ ok: true, value: { total: 10_001_000n } });
	});
	it('keeps the decimals of a stored server value beyond SP_DecNo and adds 1 (Q14)', () => {
		expect(scan(7500n)).toMatchObject({ ok: true, value: { total: 8500n } });
		expect(scan(125n)).toMatchObject({ ok: true, value: { total: 1125n } });
	});
	it('still limits what the operator types to SP_DecNo (Q14)', () => {
		expect(updateTotalScanned('8.5', 0, 1000n, true)).toEqual({ ok: false, message: 'Total: Whole numbers only.' });
	});
	it('refuses to go above the cap', () => {
		expect(scan(MAX_QUANTITY).ok).toBe(false);
	});
	it('explains a negative stored total (S19)', () => {
		expect(scan(-5000n)).toEqual({ ok: false, message: 'The stored total is negative; correct it with Update Total Scanned.' });
	});
});

describe('Update Last Scan Qty (Total field + (Last Scanned − 1))', () => {
	it('changes the last scan from 1 to N and locks the controls', () => {
		expect(updateLastScanQty('8', '12', 0)).toEqual({ ok: true, value: { total: 19_000n, lastScanned: 12_000n, lastScanEnabled: false } });
	});
	it('uses the Total field as shown, not the database', () => {
		expect(updateLastScanQty('100', '1', 0)).toMatchObject({ ok: true, value: { total: 100_000n } });
	});
	it('works with decimals when SP_DecNo allows them', () => {
		expect(updateLastScanQty('3', '2.5', 1)).toMatchObject({ ok: true, value: { total: 4500n } });
	});
	it('names the field that is wrong', () => {
		expect(updateLastScanQty('8', '2.5', 0)).toEqual({ ok: false, message: 'Last Scanned: Whole numbers only.' });
		expect(updateLastScanQty('abc', '1', 0)).toEqual({ ok: false, message: 'Total: Not a number.' });
	});
	it('refuses a result below zero', () => {
		expect(updateLastScanQty('0', '0', 0)).toEqual({ ok: false, message: 'The total cannot be negative.' });
	});
});

describe('Cancel Last Scan (Total field − Last Scanned)', () => {
	it('undoes the last scan and locks the controls', () => {
		expect(cancelLastScan('8', '1', 0)).toEqual({ ok: true, value: { total: 7000n, lastScanned: 1000n, lastScanEnabled: false } });
	});
	it('refuses a negative total (legacy allowed it)', () => {
		expect(cancelLastScan('1', '5', 0)).toEqual({ ok: false, message: 'The total cannot be negative.' });
	});
	it('handles large totals without a length lock', () => {
		expect(cancelLastScan('10000', '1', 0)).toMatchObject({ ok: true, value: { total: 9_999_000n } });
	});
});

describe('Update Total Scanned (Total field)', () => {
	it('takes the typed total and keeps the last-scan state', () => {
		expect(updateTotalScanned('25', 0, 1000n, true)).toEqual({ ok: true, value: { total: 25_000n, lastScanned: 1000n, lastScanEnabled: true } });
		expect(updateTotalScanned('0', 0, 3000n, false)).toEqual({ ok: true, value: { total: 0n, lastScanned: 3000n, lastScanEnabled: false } });
	});
	it('checks decimals by SP_DecNo', () => {
		expect(updateTotalScanned('2.125', 3, 1000n, true)).toMatchObject({ ok: true, value: { total: 2125n } });
		expect(updateTotalScanned('2.125', 2, 1000n, true)).toEqual({ ok: false, message: 'Total: At most 2 decimals.' });
	});
});
