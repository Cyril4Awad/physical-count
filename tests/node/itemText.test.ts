import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyTabText, expiryShown, expirySortKey, formatCount, ItemLine, itemRowText, pickRowText, showQty, tabLabel } from '../../src/domain/itemText';

const LINE: ItemLine = {
	pcdRecId: '47844',
	reference: 'N/PD/SEL/1/N',
	description: 'SELENIUM 100MCG 30 TABS',
	expiry: '01.2050',
	batch: '107879',
	systemQty: '12.500',
	counted: 7000n,
};

describe('Pick item row', () => {
	it('always shows the reference, lot, expiry and the current counted total', () => {
		const row = pickRowText(LINE, true);
		const everything = Object.values(row).join('\n');
		expect(everything).toContain('N/PD/SEL/1/N');
		expect(everything).toContain('107879');
		expect(everything).toContain('01.2050');
		expect(everything).toContain('Counted 7');
	});

	it('puts lot and expiry in the bold first line and the line id in the small text', () => {
		expect(pickRowText(LINE, true)).toEqual({
			title: 'Lot 107879   ·   Exp 01.2050',
			id: 'Line 47844',
			reference: 'N/PD/SEL/1/N',
			description: 'SELENIUM 100MCG 30 TABS',
			counted: 'Counted 7',
		});
	});

	it('hides lot and expiry when SP_Expiry is N: the reference becomes the bold line', () => {
		const row = pickRowText(LINE, expiryShown('N'));
		expect(row).toEqual({ title: 'N/PD/SEL/1/N', id: 'Line 47844', reference: '', description: 'SELENIUM 100MCG 30 TABS', counted: 'Counted 7' });
		expect(Object.values(row).join('\n')).not.toMatch(/107879|01\.2050|Lot|Exp/);
	});

	it('shows a dash for a missing lot or expiry, and decimals without trailing zeros', () => {
		expect(pickRowText({ ...LINE, batch: '', expiry: '', counted: 2750n }, true)).toMatchObject({ title: 'Lot —   ·   Exp —', counted: 'Counted 2.75' });
		expect(pickRowText({ ...LINE, counted: null }, true).counted).toBe('Counted 0');
	});
});

describe('Pick item rows on the Scan screen', () => {
	// The screen itself only runs on a device; this keeps it wired to the texts tested above.
	it('are drawn from pickRowText, every part of it', () => {
		const screen = readFileSync(join(__dirname, '../../src/screens/ScanScreen.tsx'), 'utf8');
		expect(screen).toContain('pickRowText(line, showExpiry)');
		for (const part of ['row.title', 'row.id', 'row.reference', 'row.description', 'row.counted']) expect(screen).toContain(`text={${part}}`);
		expect(screen).toContain('<PickRow line={l} showExpiry={showExpiry} />');
	});
});

describe('Pick item order: expiry, oldest first', () => {
	it('turns DD.MM.YYYY and MM.YYYY into sortable keys, anything else last', () => {
		expect(expirySortKey('01.01.2025')).toBe('20250101');
		expect(expirySortKey('31.12.2017')).toBe('20171231');
		expect(expirySortKey('06.2019')).toBe('20190600');
		expect(expirySortKey('')).toBe('99999999');
		expect(expirySortKey('Dec 31 2022')).toBe('99999999');
		expect(expirySortKey('1.1.2025')).toBe('99999999');
	});

	it('orders a mixed list by date, not by text', () => {
		const expiries = ['01.2050', '31.12.2017', '', '01.01.2025', '06.2019', '15.06.2019'];
		expect([...expiries].sort((a, b) => expirySortKey(a).localeCompare(expirySortKey(b)))).toEqual(['31.12.2017', '06.2019', '15.06.2019', '01.01.2025', '01.2050', '']);
	});
});

describe('Items row', () => {
	it('Counted tab: reference, description, expiry and lot, and the counted total', () => {
		expect(itemRowText(LINE, 'counted', true)).toEqual({
			reference: 'N/PD/SEL/1/N',
			description: 'SELENIUM 100MCG 30 TABS',
			detail: 'Exp 01.2050   ·   Lot 107879',
			qtyLabel: 'Counted',
			qty: '7',
		});
	});

	it('Not counted tab: the available quantity, shown as Scan shows it', () => {
		expect(itemRowText(LINE, 'notCounted', true)).toMatchObject({ qtyLabel: 'Avlb', qty: '12.5' });
		expect(itemRowText({ ...LINE, systemQty: '0.000' }, 'notCounted', true).qty).toBe('0');
		expect(itemRowText({ ...LINE, systemQty: '' }, 'notCounted', true).qty).toBe('0');
		expect(itemRowText({ ...LINE, systemQty: '-3.000' }, 'notCounted', true).qty).toBe('-3');
		expect(itemRowText({ ...LINE, systemQty: 'n/a' }, 'notCounted', true).qty).toBe('n/a');
		expect(showQty('1234567.125')).toBe('1234567.125');
	});

	it('hides expiry and lot on both tabs when SP_Expiry is N', () => {
		for (const tab of ['counted', 'notCounted'] as const) {
			const row = itemRowText(LINE, tab, expiryShown('N'));
			expect(row.detail).toBe('');
			expect(Object.values(row).join('\n')).not.toMatch(/107879|01\.2050|Lot|Exp/);
		}
	});

	it('shows expiry and lot for every other SP_Expiry value', () => {
		expect(expiryShown('Y')).toBe(true);
		expect(expiryShown('')).toBe(true);
		expect(expiryShown('N')).toBe(false);
	});

	it('counted total with decimals (count 9 at V2, SP_DecNo 3)', () => {
		expect(itemRowText({ ...LINE, counted: 2750n }, 'counted', true).qty).toBe('2.75');
		expect(itemRowText({ ...LINE, counted: 125n }, 'counted', true).qty).toBe('0.125');
		expect(itemRowText({ ...LINE, counted: 10000000n }, 'counted', true).qty).toBe('10000');
	});
});

describe('Items tabs and empty states', () => {
	it('tab labels carry their number', () => {
		expect(tabLabel('counted', 0)).toBe('Counted (0)');
		expect(tabLabel('notCounted', 11131)).toBe('Not counted (11,131)');
		expect(tabLabel('counted', null)).toBe('Counted');
		expect(formatCount(999)).toBe('999');
		expect(formatCount(1000)).toBe('1,000');
		expect(formatCount(1234567)).toBe('1,234,567');
	});

	it('one plain sentence per empty tab', () => {
		expect(emptyTabText('counted', { lines: 102, pending: 0, uploaded: 0 })).toBe('Nothing has been counted yet. Counted lines appear here.');
		expect(emptyTabText('counted', { lines: 102, pending: 0, uploaded: 5 })).toBe('No counted lines waiting for upload. 5 uploaded lines are not listed here.');
		expect(emptyTabText('counted', { lines: 102, pending: 0, uploaded: 1 })).toBe('No counted lines waiting for upload. 1 uploaded line is not listed here.');
		expect(emptyTabText('notCounted', { lines: 102, pending: 102, uploaded: 0 })).toBe('Every line of this count has been counted.');
		expect(emptyTabText('notCounted', { lines: 0, pending: 0, uploaded: 0 })).toBe('This count has no lines.');
	});
});
