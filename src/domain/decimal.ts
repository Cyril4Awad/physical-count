import { accept, Check, reject } from './check';

/**
 * Quantities as scaled integers: thousandths, as `bigint` (REBUILD_PLAN §5.3).
 * The largest allowed value (99,999,999,999,999.999) is 10¹⁷ thousandths,
 * beyond Number's exact range, so `bigint` is used throughout. No floating
 * point, so there is no drift and no length-based "Incorrect Qty" lock (D5).
 */
export type Milli = bigint;

export const SCALE = 1000n;
export const ONE: Milli = 1000n;
/** Server column is numeric(18,3); the next download's cast(… as nvarchar(18)) fails above this (S19). */
export const MAX_QUANTITY: Milli = 99_999_999_999_999_999n;
export const MAX_DECIMALS = 3;

/** Allowed decimals from the header's SP_DecNo: its value, capped at 3; anything unreadable means whole numbers. */
export function allowedDecimals(spDecNo: string): number {
	const text = (spDecNo ?? '').trim();
	if (!/^[0-9]{1,2}$/.test(text)) return 0;
	return Math.min(Number(text), MAX_DECIMALS);
}

/** Number of decimals actually used by a value (0–3). */
export function decimalsUsed(value: Milli): number {
	let fraction = (value < 0n ? -value : value) % SCALE;
	if (fraction === 0n) return 0;
	let used = MAX_DECIMALS;
	while (fraction % 10n === 0n) {
		fraction /= 10n;
		used--;
	}
	return used;
}

function toMilli(negative: boolean, whole: string, fraction: string): Milli {
	const value = BigInt(whole) * SCALE + BigInt((fraction + '000').slice(0, 3));
	return negative ? -value : value;
}

/**
 * Reads a quantity as the service stores it (`'0.000'`, `'7.000'`, `''`).
 * Server values can be negative (S19), so the sign is accepted here.
 * Returns null when the text is not a plain decimal with at most 3 decimals.
 */
export function parseStoredQuantity(text: string): Milli | null {
	const value = (text ?? '').trim();
	if (value === '') return 0n;
	const match = /^(-?)([0-9]{1,15})(?:\.([0-9]{1,3}))?$/.exec(value);
	if (!match) return null;
	return toMilli(match[1] === '-', match[2], match[3] ?? '');
}

/** Range and decimal checks shared by typed values, computed totals and upload (§3.7). */
export function checkQuantity(value: Milli, decimals: number): Check<Milli> {
	if (value < 0n) return reject('The quantity cannot be negative.');
	if (value > MAX_QUANTITY) return reject('The quantity is too large.');
	if (decimalsUsed(value) > decimals) return reject(decimals === 0 ? 'Whole numbers only.' : `At most ${decimals} decimal${decimals === 1 ? '' : 's'}.`);
	return accept(value);
}

/**
 * Upload check for `usercounted` (§3.7, Q14): ≥ 0, at most the cap, and at most
 * 3 decimals (the server column's precision) regardless of SP_DecNo. SP_DecNo
 * limits only what the operator types, so a server value that already has
 * more decimals (e.g. 7.5 with SP_DecNo 0) can still be scanned and uploaded.
 */
export function checkUploadQuantity(value: Milli): Check<Milli> {
	return checkQuantity(value, MAX_DECIMALS);
}

/**
 * Reads a quantity typed by the operator. Accepts `.` or `,` as the decimal
 * separator (the Android number keyboard may use either); no signs, no
 * exponents, no thousands separators.
 */
export function parseTypedQuantity(text: string, decimals: number): Check<Milli> {
	const value = (text ?? '').trim();
	if (value === '') return reject('Enter a quantity.');
	if (value.startsWith('-')) return reject('The quantity cannot be negative.');
	const match = /^([0-9]*)(?:[.,]([0-9]*))?$/.exec(value);
	if (!match || !/[0-9]/.test(value)) return reject('Not a number.');

	const whole = match[1].replace(/^0+(?=[0-9])/, '') || '0';
	const fraction = (match[2] ?? '').replace(/0+$/, '');
	if (fraction.length > decimals) return reject(decimals === 0 ? 'Whole numbers only.' : `At most ${decimals} decimal${decimals === 1 ? '' : 's'}.`);
	if (whole.length > 15) return reject('The quantity is too large.');
	return checkQuantity(toMilli(false, whole, fraction), decimals);
}

function split(value: Milli): { sign: string; whole: string; fraction: string } {
	const negative = value < 0n;
	const abs = negative ? -value : value;
	return {
		sign: negative ? '-' : '',
		whole: (abs / SCALE).toString(),
		fraction: (abs % SCALE).toString().padStart(3, '0').replace(/0+$/, ''),
	};
}

/** For display: no trailing zeros (`12`, `12.5`, `0.125`). */
export function formatQuantity(value: Milli): string {
	const { sign, whole, fraction } = split(value);
	return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** For `phyDetails.usercounted` on the device: 3 decimals, the same text the service sends (`'8.500'`). */
export function formatStoredQuantity(value: Milli): string {
	const negative = value < 0n;
	const abs = negative ? -value : value;
	return `${negative ? '-' : ''}${abs / SCALE}.${(abs % SCALE).toString().padStart(3, '0')}`;
}

/**
 * For InsertDetail's `usercounted` (§3.6): invariant, `.` separator, at least
 * one decimal digit (`12` → `12.0`), no exponent, no thousands separators.
 */
export function formatForUpload(value: Milli): string {
	const { sign, whole, fraction } = split(value);
	return `${sign}${whole}.${fraction || '0'}`;
}
