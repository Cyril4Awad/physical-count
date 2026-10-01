import { COLUMNS, PhyTable } from '../storage/schema';
import { ServiceDataError } from './errors';
import { tokenizeValuesQuery } from './valuesQuery';

/**
 * Where each of the app's columns sits in the service's value lists.
 * `positions[i]` is the index, in a `valuesquery`, of `COLUMNS[table][i]`.
 */
export interface ColumnMap {
	table: PhyTable;
	positions: number[];
}

/** One row ready to insert: values in the order of `COLUMNS[table]`. */
export interface PageRow {
	rowNumber: number;
	values: string[];
}

/**
 * Checks that the columns parsed from `InsertInto` are exactly the app's known
 * columns for this table (any order, compared case-insensitively) and returns
 * the position map (REBUILD_PLAN §3.5.1).
 */
export function mapColumns(table: PhyTable, parsedColumns: readonly string[]): ColumnMap {
	const known = COLUMNS[table];
	const parsedLower = parsedColumns.map((column) => column.toLowerCase());

	if (new Set(parsedLower).size !== parsedLower.length) {
		throw new ServiceDataError(`The service's table layout has changed: duplicate column in ${table}`);
	}
	const positions = known.map((column) => parsedLower.indexOf(column.toLowerCase()));
	const missing = known.filter((_, i) => positions[i] < 0);
	const extra = parsedColumns.filter((column) => !known.some((k) => k.toLowerCase() === column.toLowerCase()));
	if (missing.length || extra.length) {
		const details = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unexpected ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
		throw new ServiceDataError(`The service's table layout has changed for ${table}: ${details}`);
	}
	return { table, positions };
}

const ROW_NUMBER = /^[1-9][0-9]{0,9}$/;
const DIGITS = /^[0-9]{1,18}$/;

function column(table: PhyTable, values: string[], name: string): string {
	return values[COLUMNS[table].indexOf(name)];
}

function checkRow(table: PhyTable, values: string[], rowNumber: string): void {
	const fail = (what: string) => {
		throw new ServiceDataError(`${table} row ${rowNumber}: ${what}`);
	};
	if (table === 'phyDetails' && !DIGITS.test(column(table, values, 'Pcd_RecId'))) fail('Pcd_RecId is not a number');
	if (table === 'phyHeader') {
		if (!/^[1-6]$/.test(column(table, values, 'UserToUpdate'))) fail('UserToUpdate is not 1–6');
		if (!/^[0-9]{1,2}$/.test(column(table, values, 'SP_DecNo'))) fail('SP_DecNo is not a number');
	}
}

/**
 * Turns one page of `valuesquery` strings into rows in the app's column order
 * (REBUILD_PLAN §3.4, §3.6): tokenizes each, checks the value count, checks
 * the key fields, trims barcodes, and sorts by `RowNumber` (the service's page
 * query has no ORDER BY). Any problem rejects the whole page.
 */
export function toPageRows(map: ColumnMap, valuesQueries: readonly string[]): PageRow[] {
	const { table, positions } = map;
	const rows: PageRow[] = [];
	const seen = new Set<number>();

	for (const valuesQuery of valuesQueries) {
		const tokens = tokenizeValuesQuery(valuesQuery);
		if (tokens.length !== positions.length) {
			throw new ServiceDataError(`${table}: expected ${positions.length} values, got ${tokens.length}`);
		}
		const values = positions.map((position) => tokens[position]);
		const rowNumberText = values[0];
		if (!ROW_NUMBER.test(rowNumberText)) throw new ServiceDataError(`${table}: invalid RowNumber "${rowNumberText}"`);
		const rowNumber = Number(rowNumberText);
		if (seen.has(rowNumber)) throw new ServiceDataError(`${table}: RowNumber ${rowNumber} appears twice in one page`);
		seen.add(rowNumber);

		checkRow(table, values, rowNumberText);
		if (table === 'phyBarcodes') {
			const barcodeIndex = COLUMNS.phyBarcodes.indexOf('PcBarc_Barcode');
			values[barcodeIndex] = values[barcodeIndex].trim();
		}
		rows.push({ rowNumber, values });
	}
	return rows.sort((a, b) => a.rowNumber - b.rowNumber);
}
