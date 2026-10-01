import { parseQr } from './qr';

/**
 * Scan lookup in the legacy order (REBUILD_PLAN §5.2, D1, D2):
 * exact barcode → reference prefix → QR → not found.
 * The storage layer implements the repository with parameterized SQL.
 */
export interface LookupRepository {
	/** `Pcd_RecId` of the first `phyBarcodes` row (by RowNumber) whose barcode equals the value, or null. */
	findByBarcode(barcode: string): Promise<string | null>;
	/**
	 * `Pcd_RecId`s of lines whose `Refernce` starts with `prefix` (ASCII
	 * case-insensitive, `%` and `_` literal), in RowNumber order, at most `limit`.
	 */
	findByReferencePrefix(prefix: string, limit: number): Promise<string[]>;
	/** `Pcd_RecId` of the first line (by RowNumber) with exactly this stock id, expiry and batch, or null. */
	findByQr(stkId: string, exp: string, batch: string): Promise<string | null>;
}

export type LookupResult =
	| { kind: 'empty' }
	| { kind: 'found'; lineId: string; via: 'barcode' | 'reference' | 'qr'; value: string }
	/** More than one reference starts with the value: open Pick item pre-filled with it. */
	| { kind: 'pick'; value: string }
	| { kind: 'invalidQr'; value: string }
	| { kind: 'notFound'; value: string };

export async function lookupScan(raw: string, repository: LookupRepository): Promise<LookupResult> {
	const value = raw.trim();
	if (value === '') return { kind: 'empty' };

	const byBarcode = await repository.findByBarcode(value);
	if (byBarcode !== null) return { kind: 'found', lineId: byBarcode, via: 'barcode', value };

	const byReference = await repository.findByReferencePrefix(value, 2);
	if (byReference.length === 1) return { kind: 'found', lineId: byReference[0], via: 'reference', value };
	if (byReference.length > 1) return { kind: 'pick', value };

	const qr = parseQr(value);
	if (qr.kind === 'invalidQr') return { kind: 'invalidQr', value };
	if (qr.kind === 'qr') {
		const byQr = await repository.findByQr(qr.stkId, qr.exp, qr.batch);
		if (byQr !== null) return { kind: 'found', lineId: byQr, via: 'qr', value };
	}
	return { kind: 'notFound', value };
}

/**
 * `LIKE … ESCAPE '\'` pattern for a reference prefix (§4.3): `\`, `%` and `_`
 * in the scanned text are escaped so they match literally.
 */
export function likePrefixPattern(prefix: string): string {
	return prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
}
