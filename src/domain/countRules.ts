import { accept, Check, reject } from './check';
import { MAX_QUANTITY, Milli, ONE, parseTypedQuantity } from './decimal';

/**
 * Count rules on the Scan screen (REBUILD_PLAN §5.3, legacy formulas).
 * The three buttons work from the fields on screen, as legacy did.
 * Every successful result is written as `usercounted = total, updated = '1'`.
 */
export interface CountResult {
	total: Milli;
	/** Value to show in the Last Scanned field. */
	lastScanned: Milli;
	/** Whether Update Last Scan Qty and Cancel Last Scan are enabled afterwards. */
	lastScanEnabled: boolean;
}

/**
 * A computed total can only go wrong by range: typed inputs already passed the
 * decimal check, and a stored server value is accepted with the decimals it has.
 */
function checkTotal(total: Milli): Check<Milli> {
	if (total < 0n) return reject('The total cannot be negative.');
	if (total > MAX_QUANTITY) return reject('The total is too large.');
	return accept(total);
}

/** A scan (or a pick from Pick item): stored total + 1; Last Scanned = 1. */
export function scan(stored: Milli): Check<CountResult> {
	const total = checkTotal(stored + ONE);
	if (!total.ok) return reject(stored < 0n ? 'The stored total is negative; correct it with Update Total Scanned.' : total.message);
	return accept({ total: total.value, lastScanned: ONE, lastScanEnabled: true });
}

/** Update Last Scan Qty: Total field + (Last Scanned − 1); then the last-scan controls lock. */
export function updateLastScanQty(totalText: string, lastScannedText: string, decimals: number): Check<CountResult> {
	const total = parseTypedQuantity(totalText, decimals);
	if (!total.ok) return reject(`Total: ${total.message}`);
	const last = parseTypedQuantity(lastScannedText, decimals);
	if (!last.ok) return reject(`Last Scanned: ${last.message}`);
	const result = checkTotal(total.value + (last.value - ONE));
	if (!result.ok) return result;
	return accept({ total: result.value, lastScanned: last.value, lastScanEnabled: false });
}

/** Cancel Last Scan: Total field − Last Scanned; then the last-scan controls lock. */
export function cancelLastScan(totalText: string, lastScannedText: string, decimals: number): Check<CountResult> {
	const total = parseTypedQuantity(totalText, decimals);
	if (!total.ok) return reject(`Total: ${total.message}`);
	const last = parseTypedQuantity(lastScannedText, decimals);
	if (!last.ok) return reject(`Last Scanned: ${last.message}`);
	const result = checkTotal(total.value - last.value);
	if (!result.ok) return result;
	return accept({ total: result.value, lastScanned: last.value, lastScanEnabled: false });
}

/** Update Total Scanned: the Total field as typed. The last-scan controls keep their state. */
export function updateTotalScanned(totalText: string, decimals: number, lastScanned: Milli, lastScanEnabled: boolean): Check<CountResult> {
	const total = parseTypedQuantity(totalText, decimals);
	if (!total.ok) return reject(`Total: ${total.message}`);
	return accept({ total: total.value, lastScanned, lastScanEnabled });
}
