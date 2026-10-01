import { PHY_TABLES, PhyTable } from '../storage/schema';
import { ServiceDataError } from './errors';
import { parseInsertInto } from './insertInto';
import { ColumnMap, mapColumns } from './rows';
import type { TableInfo } from '../soap/responses';

/** One table of a download, as it will be stored in tblPullStatus (REBUILD_PLAN §3.3, §4.2). */
export interface ManifestEntry {
	tableName: string;
	originalTableName: PhyTable;
	displayHeader: string;
	rowsCount: number;
	columns: string[];
	columnMap: ColumnMap;
}

export type ManifestResult =
	| { kind: 'ok'; entries: ManifestEntry[] }
	/**
	 * `notFound`: the header did not match (RowsCount 0): wrong number, cancelled or posted,
	 * another location, or the machine is not a machine user (§3.3 step 5).
	 * `incomplete`: the header matched (RowsCount ≥ 1) but no details table came back. The service
	 * swallows its own errors (S12), so this is a server failure while preparing the lines, e.g. a
	 * SQL timeout (seen in step 6: 30 s, header only). Trying again usually works.
	 */
	| { kind: 'notDownloadable'; reason: NotDownloadableReason };

/**
 * `notFound`: header RowsCount 0 (or no header). `incomplete`: header found but **no phyDetails
 * entry at all** in the answer. `noLines`: a phyDetails entry with RowsCount 0: the count has no lines.
 */
export type NotDownloadableReason = 'notFound' | 'incomplete' | 'noLines';

const TABLE_KIND: Record<PhyTable, string> = {
	phyHeader: 'Header',
	phyDetails: 'Detail',
	phyBarcodes: 'DetBarcode',
};

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `TableName` goes back to the service, which splices it into SQL, so it must match exactly (§3.7). */
export function isExpectedTableName(tableName: string, table: PhyTable, location: string, machine: string): boolean {
	const pattern = new RegExp(`^_ERPDATACOLLECTOR_tbl_PhysicalCount${TABLE_KIND[table]}_${escapeRegExp(location + machine)}$`, 'i');
	return pattern.test(tableName);
}

/**
 * Checks the `InitPullTables` tables for this location + machine and builds the
 * download manifest (REBUILD_PLAN §3.3 steps 2–5). `InsertInto` is parsed for
 * its columns only; `CreateTable` is not used.
 */
export function buildManifest(tables: readonly TableInfo[], location: string, machine: string): ManifestResult {
	const mine = tables.filter((t) => t.SelectedLocation === location && t.MachineName === machine);
	const entries: ManifestEntry[] = [];

	for (const info of mine) {
		const table = PHY_TABLES.find((t) => t === info.OriginalTableName);
		if (!table) throw new ServiceDataError(`Unexpected table "${info.OriginalTableName}"`);
		if (entries.some((e) => e.originalTableName === table)) throw new ServiceDataError(`Table ${table} listed twice`);
		if (!isExpectedTableName(info.TableName, table, location, machine)) {
			throw new ServiceDataError(`Unexpected server table name "${info.TableName}" for ${table}`);
		}
		if (!/^[0-9]{1,9}$/.test(info.RowsCount)) throw new ServiceDataError(`Invalid RowsCount "${info.RowsCount}" for ${table}`);

		const columns = parseInsertInto(info.InsertInto, table);
		entries.push({
			tableName: info.TableName,
			originalTableName: table,
			displayHeader: info.PullDisplayHeader,
			rowsCount: Number(info.RowsCount),
			columns,
			columnMap: mapColumns(table, columns),
		});
	}

	const header = entries.find((e) => e.originalTableName === 'phyHeader');
	const details = entries.find((e) => e.originalTableName === 'phyDetails');
	if (!header || header.rowsCount === 0) return { kind: 'notDownloadable', reason: 'notFound' };
	if (!details) return { kind: 'notDownloadable', reason: 'incomplete' };
	if (details.rowsCount === 0) return { kind: 'notDownloadable', reason: 'noLines' };

	const ordered = PHY_TABLES.map((t) => entries.find((e) => e.originalTableName === t)).filter((e): e is ManifestEntry => e !== undefined);
	return { kind: 'ok', entries: ordered };
}
