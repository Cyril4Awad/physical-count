import { formatQuantity, Milli, parseStoredQuantity } from './decimal';

/**
 * What a line shows in the Pick item rows (Scan) and in the Items lists
 * (REBUILD_PLAN §2.1). Pure module, so the row contents are pinned by Node tests.
 */

export type ItemsTab = 'counted' | 'notCounted';

/** The fields of a sheet line that the rows show (`Line` in storage/locationDb has them all). */
export interface ItemLine {
	pcdRecId: string;
	reference: string;
	description: string;
	expiry: string;
	batch: string;
	/** `Pcd_Qty` as stored. */
	systemQty: string;
	/** `usercounted`; null when the stored text is not a readable quantity. */
	counted: Milli | null;
}

/** A stored quantity for display: no trailing zeros; text that is not a quantity is shown as it is. */
export function showQty(text: string): string {
	const value = parseStoredQuantity(text);
	return value === null ? text : formatQuantity(value);
}

/** `SP_Expiry = 'N'` hides Expiry and Lot everywhere (§3.6). */
export function expiryShown(spExpiry: string): boolean {
	return spExpiry !== 'N';
}

const countedText = (line: ItemLine) => formatQuantity(line.counted ?? 0n);
const orDash = (text: string) => text || '—';

/**
 * Sort key for `exp` as the service sends it: `DD.MM.YYYY` → `YYYYMMDD`, `MM.YYYY` → `YYYYMM00`.
 * Anything else (empty, unreadable) sorts last. `EXPIRY_ORDER_SQL` in storage/locationDb is the same rule in SQL.
 */
export function expirySortKey(exp: string): string {
	const full = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/.exec(exp);
	if (full) return full[3] + full[2] + full[1];
	const month = /^([0-9]{2})\.([0-9]{4})$/.exec(exp);
	if (month) return month[2] + month[1] + '00';
	return '99999999';
}

export interface PickRowText {
	/** Bold first line: lot and expiry, the two things that tell the lots of one item apart. */
	title: string;
	/** Small muted text: the line id. */
	id: string;
	reference: string;
	description: string;
	/** The line's current counted total. */
	counted: string;
}

/** One Pick item row. With expiry and lot hidden (`SP_Expiry = 'N'`), the reference is the bold line. */
export function pickRowText(line: ItemLine, showExpiry: boolean): PickRowText {
	return {
		title: showExpiry ? `Lot ${orDash(line.batch)}   ·   Exp ${orDash(line.expiry)}` : line.reference,
		id: `Line ${line.pcdRecId}`,
		reference: showExpiry ? line.reference : '',
		description: line.description,
		counted: `Counted ${countedText(line)}`,
	};
}

export interface ItemRowText {
	reference: string;
	description: string;
	/** Expiry and lot; empty when they are hidden. */
	detail: string;
	qtyLabel: string;
	qty: string;
}

/** One Items row: the counted total on the Counted tab, the available quantity (as Scan shows it) on Not counted. */
export function itemRowText(line: ItemLine, tab: ItemsTab, showExpiry: boolean): ItemRowText {
	return {
		reference: line.reference,
		description: line.description,
		detail: showExpiry ? `Exp ${orDash(line.expiry)}   ·   Lot ${orDash(line.batch)}` : '',
		qtyLabel: tab === 'counted' ? 'Counted' : 'Avlb',
		qty: tab === 'counted' ? countedText(line) : showQty(line.systemQty),
	};
}

/** 11131 → `11,131` (no Intl: the same text in Node and on the device). */
export function formatCount(n: number): string {
	return String(n).replace(/\B(?=([0-9]{3})+$)/g, ',');
}

export function tabLabel(tab: ItemsTab, n: number | null): string {
	const name = tab === 'counted' ? 'Counted' : 'Not counted';
	return n === null ? name : `${name} (${formatCount(n)})`;
}

/** The sentence shown instead of an empty list. */
export function emptyTabText(tab: ItemsTab, counters: { lines: number; pending: number; uploaded: number }): string {
	if (counters.lines === 0) return 'This count has no lines.';
	if (tab === 'counted') {
		return counters.uploaded > 0
			? `No counted lines waiting for upload. ${formatCount(counters.uploaded)} uploaded ${counters.uploaded === 1 ? 'line is' : 'lines are'} not listed here.`
			: 'Nothing has been counted yet. Counted lines appear here.';
	}
	return 'Every line of this count has been counted.';
}

export const NO_SHEET_TEXT = 'No count has been downloaded for this location yet. Use Download on the Home screen first.';
export const DOWNLOAD_RUNNING_TEXT = 'A download is in progress. Finish or abandon it in Download first.';
