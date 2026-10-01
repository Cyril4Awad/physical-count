import { describe, expect, it } from 'vitest';
import { likePrefixPattern, LookupRepository, lookupScan } from '../../src/domain/lookup';
import { parseQr } from '../../src/domain/qr';

describe('parseQr (legacy conversion)', () => {
	it('builds DD.MM.YY from DD/MM/YY', () => {
		expect(parseQr('992|01/01/25|J16-3135')).toEqual({ kind: 'qr', stkId: '992', exp: '01.01.25', batch: 'J16-3135' });
	});
	it('builds MM.YY when the day is 00', () => {
		expect(parseQr('992|00/06/2025|L1')).toEqual({ kind: 'qr', stkId: '992', exp: '06.2025', batch: 'L1' });
	});
	it('copies the year as printed (a 4-digit year matches the service format)', () => {
		expect(parseQr('992|01/01/2025|J16-3135')).toMatchObject({ exp: '01.01.2025' });
	});
	it('ignores extra parts, as legacy did', () => {
		expect(parseQr('992|01/01/25|L1|extra')).toMatchObject({ kind: 'qr', batch: 'L1' });
	});
	it('is not a QR code without |', () => {
		expect(parseQr('5285002192105')).toEqual({ kind: 'notQr' });
	});
	it.each([
		['two parts', '992|01/01/25'],
		['an empty batch (Java split drops it)', '992|01/01/25|'],
		['no date', '992||L1'],
		['a two-part date', '992|01/25|L1'],
		['a date with an empty year (Java split drops it)', '992|01/01/|L1'],
		['an empty day', '992|/01/25|L1'],
		['only bars', '||'],
	])('reports %s as invalid', (_label, value) => {
		expect(parseQr(value)).toEqual({ kind: 'invalidQr' });
	});
});

interface Line {
	rowNumber: number;
	id: string;
	reference: string;
	stkId: string;
	exp: string;
	batch: string;
}

/** In-memory repository with the same semantics as the SQL one (§4.3). */
function repository(lines: Line[], barcodes: { rowNumber: number; barcode: string; lineId: string }[]) {
	const calls: string[] = [];
	const byRow = <T extends { rowNumber: number }>(rows: T[]) => [...rows].sort((a, b) => a.rowNumber - b.rowNumber);
	const repo: LookupRepository = {
		async findByBarcode(barcode) {
			calls.push('barcode');
			return byRow(barcodes).find((b) => b.barcode === barcode)?.lineId ?? null;
		},
		async findByReferencePrefix(prefix, limit) {
			calls.push('reference');
			const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()); // SQLite LIKE: ASCII only
			return byRow(lines)
				.filter((l) => lower(l.reference).startsWith(lower(prefix)))
				.slice(0, limit)
				.map((l) => l.id);
		},
		async findByQr(stkId, exp, batch) {
			calls.push('qr');
			return byRow(lines).find((l) => l.stkId === stkId && l.exp === exp && l.batch === batch)?.id ?? null;
		},
	};
	return { repo, calls };
}

const LINES: Line[] = [
	{ rowNumber: 1, id: '47842', reference: 'N/PD/SEL/1/N', stkId: '992', exp: '01.01.2025', batch: 'J16-3135' },
	{ rowNumber: 2, id: '47843', reference: 'N/PD/SEL/2/N', stkId: '993', exp: '06.2025', batch: 'L2' },
	{ rowNumber: 3, id: '40767', reference: 'ABC100', stkId: '246', exp: '01.03.2026', batch: 'A' },
	{ rowNumber: 4, id: '36341', reference: 'XYZ200', stkId: '1416', exp: '01.09.2026', batch: 'B' },
	{ rowNumber: 5, id: '50000', reference: '5285002192105-REF', stkId: '5', exp: '', batch: '' },
	{ rowNumber: 6, id: '50001', reference: '100%_OFF', stkId: '6', exp: '', batch: '' },
];
// Count 10 at CV has 2000000000848 on two items (stock ids 246 and 1416); first by RowNumber wins (Q7).
const BARCODES = [
	{ rowNumber: 9, barcode: '2000000000848', lineId: '36341' },
	{ rowNumber: 7, barcode: '2000000000848', lineId: '40767' },
	{ rowNumber: 1, barcode: '5285002192105', lineId: '47843' },
	{ rowNumber: 6, barcode: '', lineId: '47842' },
];

describe('lookupScan (exact barcode → reference prefix → QR)', () => {
	it('ignores an empty or blank scan', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('   ', repo)).toEqual({ kind: 'empty' });
		expect(calls).toEqual([]);
	});

	it('finds an exact barcode first, even when it is also a reference prefix', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('5285002192105', repo)).toEqual({ kind: 'found', lineId: '47843', via: 'barcode', value: '5285002192105' });
		expect(calls).toEqual(['barcode']);
	});

	it('takes the first line by RowNumber for a barcode on two items (Q7)', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan('2000000000848', repo)).toMatchObject({ kind: 'found', lineId: '40767', via: 'barcode' });
	});

	it('reaches the second item of that barcode by its reference (Q7)', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan('XYZ200', repo)).toMatchObject({ kind: 'found', lineId: '36341', via: 'reference' });
	});

	it('trims the scan', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan(' 2000000000848\n', repo)).toMatchObject({ lineId: '40767', value: '2000000000848' });
	});

	it('counts a single reference prefix match automatically, case-insensitively (D2)', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('abc', repo)).toEqual({ kind: 'found', lineId: '40767', via: 'reference', value: 'abc' });
		expect(calls).toEqual(['barcode', 'reference']);
	});

	it('opens Pick item when several references match', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('N/PD/SEL', repo)).toEqual({ kind: 'pick', value: 'N/PD/SEL' });
		expect(calls).toEqual(['barcode', 'reference']);
	});

	it('tries QR only after barcode and reference found nothing', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('992|01/01/2025|J16-3135', repo)).toMatchObject({ kind: 'found', lineId: '47842', via: 'qr' });
		expect(calls).toEqual(['barcode', 'reference', 'qr']);
	});

	it('matches a 00-day QR against an MM.YYYY expiry', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan('993|00/06/2025|L2', repo)).toMatchObject({ kind: 'found', lineId: '47843', via: 'qr' });
	});

	it('does not match a 2-digit-year sticker against a 4-digit expiry (legacy behaviour; go-live check)', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan('992|01/01/25|J16-3135', repo)).toEqual({ kind: 'notFound', value: '992|01/01/25|J16-3135' });
	});

	it('reports an invalid QR without querying for it', async () => {
		const { repo, calls } = repository(LINES, BARCODES);
		expect(await lookupScan('992|01/01/25', repo)).toEqual({ kind: 'invalidQr', value: '992|01/01/25' });
		expect(calls).toEqual(['barcode', 'reference']);
	});

	it('reports not found', async () => {
		const { repo } = repository(LINES, BARCODES);
		expect(await lookupScan('0000000000000', repo)).toEqual({ kind: 'notFound', value: '0000000000000' });
	});
});

describe('likePrefixPattern', () => {
	it('escapes LIKE wildcards so they match literally', () => {
		expect(likePrefixPattern('ABC')).toBe('ABC%');
		expect(likePrefixPattern('100%_OFF')).toBe('100\\%\\_OFF%');
		expect(likePrefixPattern('a\\b')).toBe('a\\\\b%');
	});
});
