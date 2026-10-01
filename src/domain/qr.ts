/**
 * QR sticker conversion, exactly as legacy `BarcodeScan.GetDescription` did
 * (REBUILD_PLAN §5.2): `stkId|DD/MM/YY|Batch` → match `Pcd_stkId`, `exp`,
 * `Pcd_Batch`. The date parts are copied as printed (no year expansion);
 * a `00` day gives `MM.YY`, otherwise `DD.MM.YY`.
 */
export type QrParse = { kind: 'notQr' } | { kind: 'invalidQr' } | { kind: 'qr'; stkId: string; exp: string; batch: string };

/** Java's `String.split(regex)`: trailing empty strings are removed. Legacy relied on it for its length checks. */
function javaSplit(text: string, separator: string): string[] {
	const parts = text.split(separator);
	while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
	return parts;
}

export function parseQr(value: string): QrParse {
	if (!value.includes('|')) return { kind: 'notQr' };

	const parts = javaSplit(value, '|');
	if (parts.length < 3) return { kind: 'invalidQr' };
	const [stkId, date, batch] = parts;

	const dateParts = javaSplit(date, '/');
	if (dateParts.length < 3) return { kind: 'invalidQr' };
	const [day, month, year] = dateParts;
	// An empty day or month (`/01/25`) could never match an expiry the service sends.
	if (day === '' || month === '') return { kind: 'invalidQr' };

	const exp = day === '00' ? `${month}.${year}` : `${day}.${month}.${year}`;
	return { kind: 'qr', stkId, exp, batch };
}
