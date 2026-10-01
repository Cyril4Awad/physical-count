import { formatStoredQuantity, Milli, parseStoredQuantity } from '../domain/decimal';
import { likePrefixPattern, LookupRepository } from '../domain/lookup';
import { ColumnMap, mapColumns, PageRow } from '../parse/rows';
import type { ManifestEntry } from '../parse/manifest';
import { Database, databaseFileExists, deleteDatabaseFile, OpenOptions } from './database';
import { COLUMNS, createSchemaStatements, insertStatement, PHY_TABLES, PhyTable, SCHEMA_VERSION, SHEET_V3_COLUMNS, stagingTable, StagingTable } from './schema';
import type { UploadLine } from './upload';

/**
 * One location database, `ERPDataCollectorNDB_<location as typed>` (REBUILD_PLAN §4, §6.1).
 * All SQL uses bound parameters; table and column names come only from ./schema constants.
 */

const LOCATION_CODE = /^[A-Za-z0-9]{1,2}$/;

/** Location code kept exactly as typed, including case (no upper-casing). */
export function locationDbFileName(location: string): string {
	if (!LOCATION_CODE.test(location)) throw new Error(`Invalid location code "${location}"`);
	return `ERPDataCollectorNDB_${location}`;
}

export function deleteLocationDbFile(fileName: string): void {
	deleteDatabaseFile(fileName);
}

/** Raised when the live sheet is changed while a download is in progress (§5.1 download lock). */
export class SheetLockedError extends Error {
	constructor() {
		super('A download is in progress; finish or abandon it first.');
		this.name = 'SheetLockedError';
	}
}

export interface InsertPageResult {
	inserted: number;
	/** Rows whose RowNumber was already stored (resume de-duplication, §3.4). */
	skipped: number;
}

/** One row of tblPullStatus: a table of the download in progress. */
export interface PullStatus {
	id: number;
	countNumber: string;
	location: string;
	machine: string;
	tableName: string;
	table: PhyTable;
	displayHeader: string;
	rowsCount: number;
	rowsStored: number;
	finished: boolean;
	columns: string[];
	columnMap: ColumnMap;
}

export interface StorePageResult extends InsertPageResult {
	rowsStored: number;
	finished: boolean;
}

export interface SheetInfo {
	countNumber: string;
	machineName: string;
	downloadedAt: string;
	invId: string;
	userToUpdate: string;
	spDecNo: string;
	spExpiry: string;
	spFashion: string;
	warehouse: string;
	dateCount: string;
	/** ISO time of the last upload run that sent at least one line; '' when there is none for this sheet. */
	lastUploadAt: string;
	lastUploadLines: number;
}

/** Numbers for Home (§2.1). */
export interface SheetCounters {
	lines: number;
	notCounted: number;
	pending: number;
	uploaded: number;
}

export interface Line {
	id: number;
	rowNumber: number;
	pcdRecId: string;
	stkId: string;
	reference: string;
	description: string;
	colorDescription: string;
	expiry: string;
	batch: string;
	systemQty: string;
	/** `usercounted` as stored; null when the text is not a readable quantity. */
	counted: Milli | null;
	state: '0' | '1' | '2';
}

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/** The phyDetails columns a `Line` is built from: list queries read these, not all 28. */
const LINE_COLUMNS = '_id, RowNumber, Pcd_RecId, Pcd_stkId, Refernce, stk_Desc, Color_Desc, exp, Pcd_Batch, Pcd_Qty, usercounted, updated';

/**
 * `exp` as a sortable key, oldest first: `DD.MM.YYYY` → `YYYYMMDD`, `MM.YYYY` → `YYYYMM00`,
 * anything else last. The same rule as `expirySortKey` in domain/itemText.
 */
const EXPIRY_ORDER_SQL =
	"CASE WHEN exp GLOB '[0-9][0-9].[0-9][0-9].[0-9][0-9][0-9][0-9]' THEN substr(exp, 7, 4) || substr(exp, 4, 2) || substr(exp, 1, 2) " +
	"WHEN exp GLOB '[0-9][0-9].[0-9][0-9][0-9][0-9]' THEN substr(exp, 4, 4) || substr(exp, 1, 2) || '00' ELSE '99999999' END";

/** Android binds every parameter as text, which LIMIT and OFFSET may refuse; they are checked integers written into the SQL. */
function checkedInteger(name: string, value: number, min: number): number {
	if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name} ${value}`);
	return value;
}

function toLine(row: Record<string, unknown>): Line {
	const state = text(row.updated);
	return {
		id: Number(row._id),
		rowNumber: Number(row.RowNumber),
		pcdRecId: text(row.Pcd_RecId),
		stkId: text(row.Pcd_stkId),
		reference: text(row.Refernce),
		description: text(row.stk_Desc),
		colorDescription: text(row.Color_Desc),
		expiry: text(row.exp),
		batch: text(row.Pcd_Batch),
		systemQty: text(row.Pcd_Qty),
		counted: parseStoredQuantity(text(row.usercounted)),
		state: state === '1' || state === '2' ? state : '0',
	};
}

export class LocationDb {
	private constructor(private readonly db: Database) {}

	static open(fileName: string, options: OpenOptions = {}): LocationDb {
		return new LocationDb(Database.open(fileName, options));
	}

	close(): void {
		this.db.close();
	}

	/** Creates the schema on a new database and upgrades an older one; does nothing on a current one. */
	async ensureSchema(): Promise<void> {
		if ((await this.db.userVersion()) >= SCHEMA_VERSION) return;
		await this.db.inTransaction(async () => {
			for (const statement of createSchemaStatements()) await this.db.execute(statement);
			// A tblSheet created by version 1 or 2 lacks the version 3 columns; its row is kept.
			const existing = (await this.db.select('PRAGMA table_info(tblSheet)')).map((column) => text(column.name));
			for (const [name, type] of SHEET_V3_COLUMNS) {
				if (!existing.includes(name)) await this.db.execute(`ALTER TABLE tblSheet ADD COLUMN ${name} ${type}`);
			}
		});
		await this.db.setUserVersion(SCHEMA_VERSION);
	}

	userVersion(): Promise<number> {
		return this.db.userVersion();
	}

	// ── Pages ────────────────────────────────────────────────────────────────

	/** Inserts rows whose RowNumber is not stored yet. Must run inside a transaction. */
	private async insertRows(target: PhyTable | StagingTable, table: PhyTable, rows: readonly PageRow[]): Promise<InsertPageResult> {
		if (rows.length === 0) return { inserted: 0, skipped: 0 };
		const sql = insertStatement(target, table);
		const existing = await this.db.select(`SELECT RowNumber FROM ${target} WHERE RowNumber BETWEEN ? AND ?`, [
			rows[0].rowNumber,
			rows[rows.length - 1].rowNumber,
		]);
		const stored = new Set(existing.map((row) => Number(row.RowNumber)));
		let inserted = 0;
		for (const row of rows) {
			if (stored.has(row.rowNumber)) continue;
			await this.db.execute(sql, [row.rowNumber, ...row.values.slice(1)]);
			inserted++;
		}
		return { inserted, skipped: rows.length - inserted };
	}

	/** Inserts one page in one transaction: every new row is stored or none is (§4.3). */
	insertPage(table: PhyTable, rows: readonly PageRow[], options: { staging?: boolean } = {}): Promise<InsertPageResult> {
		const target = options.staging ? stagingTable(table) : table;
		return this.db.inTransaction(() => this.insertRows(target, table, rows));
	}

	async count(table: PhyTable | StagingTable): Promise<number> {
		return this.db.scalar(`SELECT COUNT(*) FROM ${table}`);
	}

	/** Test/diagnostic helper: rows of a table ordered by RowNumber. */
	selectAll(table: PhyTable | StagingTable): Promise<Record<string, unknown>[]> {
		return this.db.select(`SELECT * FROM ${table} ORDER BY RowNumber`);
	}

	// ── Staged download (§6.1) ───────────────────────────────────────────────

	/**
	 * Step 4 of §6.1: clears the staging tables and writes the manifest in one
	 * transaction. The live sheet is not touched.
	 */
	async startDownload(countNumber: string, location: string, machine: string, entries: readonly ManifestEntry[]): Promise<void> {
		const startedAt = new Date().toISOString();
		await this.db.inTransaction(async () => {
			for (const table of PHY_TABLES) await this.db.execute(`DELETE FROM ${stagingTable(table)}`);
			await this.db.execute('DELETE FROM tblPullStatus');
			for (const entry of entries) {
				const finished = entry.rowsCount === 0 ? 1 : 0;
				await this.db.execute(
					'INSERT INTO tblPullStatus(CountNumber, SelectedLocation, MachineName, TableName, OriginalTableName, PullDisplayHeader, ' +
						'RowsCount, RowsStored, PullFinished, Columns, StartedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
					[countNumber, location, machine, entry.tableName, entry.originalTableName, entry.displayHeader, entry.rowsCount, 0, finished, JSON.stringify(entry.columns), startedAt],
				);
			}
		});
	}

	/** The manifest of the download in progress, in table order; empty when there is none. */
	async pullStatus(): Promise<PullStatus[]> {
		const rows = await this.db.select('SELECT * FROM tblPullStatus ORDER BY _id');
		return rows.map((row) => {
			const table = PHY_TABLES.find((t) => t === row.OriginalTableName);
			if (!table) throw new Error(`Unexpected table "${text(row.OriginalTableName)}" in tblPullStatus`);
			const columns = JSON.parse(text(row.Columns)) as string[];
			return {
				id: Number(row._id),
				countNumber: text(row.CountNumber),
				location: text(row.SelectedLocation),
				machine: text(row.MachineName),
				tableName: text(row.TableName),
				table,
				displayHeader: text(row.PullDisplayHeader),
				rowsCount: Number(row.RowsCount),
				rowsStored: Number(row.RowsStored),
				finished: Number(row.PullFinished) === 1,
				columns,
				columnMap: mapColumns(table, columns),
			};
		});
	}

	async isDownloadInProgress(): Promise<boolean> {
		return (await this.db.scalar('SELECT COUNT(*) FROM tblPullStatus')) > 0;
	}

	/**
	 * Stores one page into the staging table and updates RowsStored and
	 * PullFinished in the same transaction (§4.3). Rows already staged are skipped.
	 */
	async storePage(table: PhyTable, rows: readonly PageRow[]): Promise<StorePageResult> {
		return this.db.inTransaction(async () => {
			const status = await this.db.get('SELECT _id, RowsCount, RowsStored FROM tblPullStatus WHERE OriginalTableName = ?', [table]);
			if (!status) throw new Error(`No download in progress for ${table}`);
			const result = await this.insertRows(stagingTable(table), table, rows);
			const rowsStored = Number(status.RowsStored) + result.inserted;
			const finished = rowsStored >= Number(status.RowsCount);
			await this.db.execute('UPDATE tblPullStatus SET RowsStored = ?, PullFinished = ? WHERE _id = ?', [rowsStored, finished ? 1 : 0, status._id]);
			return { ...result, rowsStored, finished };
		});
	}

	/**
	 * Step 6 of §6.1: when every table is complete, replaces the live sheet
	 * with the staged one in one transaction, writes tblSheet and clears the
	 * staging tables and the manifest. Throws (and changes nothing) otherwise.
	 */
	async applyDownload(): Promise<void> {
		await this.db.inTransaction(async () => {
			const statuses = await this.db.select('SELECT OriginalTableName, RowsStored, PullFinished, CountNumber, MachineName FROM tblPullStatus');
			if (statuses.length === 0) throw new Error('No download in progress');
			for (const status of statuses) {
				const table = PHY_TABLES.find((t) => t === status.OriginalTableName);
				if (!table) throw new Error(`Unexpected table "${text(status.OriginalTableName)}"`);
				if (Number(status.PullFinished) !== 1) throw new Error(`${table} is not complete`);
				const staged = await this.db.scalar(`SELECT COUNT(*) FROM ${stagingTable(table)}`);
				if (staged !== Number(status.RowsStored)) throw new Error(`${table}: ${staged} rows staged, ${text(status.RowsStored)} expected`);
			}
			if ((await this.db.scalar('SELECT COUNT(*) FROM stg_phyHeader')) < 1) throw new Error('The downloaded count has no header');

			for (const table of PHY_TABLES) {
				const columns = COLUMNS[table].join(',');
				await this.db.execute(`DELETE FROM ${table}`);
				await this.db.execute(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM ${stagingTable(table)} ORDER BY RowNumber`);
				await this.db.execute(`DELETE FROM ${stagingTable(table)}`);
			}
			await this.db.execute('INSERT OR REPLACE INTO tblSheet(_id, CountNumber, MachineName, DownloadedAt) VALUES (1, ?, ?, ?)', [
				statuses[0].CountNumber,
				statuses[0].MachineName,
				new Date().toISOString(),
			]);
			await this.db.execute('DELETE FROM tblPullStatus');
		});
	}

	/** Abandon download (§6.1): clears staging and the manifest; the live sheet is not touched. */
	async abandonDownload(): Promise<void> {
		await this.db.inTransaction(async () => {
			for (const table of PHY_TABLES) await this.db.execute(`DELETE FROM ${stagingTable(table)}`);
			await this.db.execute('DELETE FROM tblPullStatus');
		});
	}

	// ── Live sheet ───────────────────────────────────────────────────────────

	async sheetInfo(): Promise<SheetInfo | null> {
		const sheet = await this.db.get('SELECT CountNumber, MachineName, DownloadedAt, LastUploadAt, LastUploadLines FROM tblSheet WHERE _id = 1');
		const header = await this.db.get(
			'SELECT InvID, UserToUpdate, SP_DecNo, SP_Expiry, SP_Fashion, Warehouse, Pch_DateCount FROM phyHeader ORDER BY RowNumber LIMIT 1',
		);
		if (!sheet || !header) return null;
		return {
			countNumber: text(sheet.CountNumber),
			machineName: text(sheet.MachineName),
			downloadedAt: text(sheet.DownloadedAt),
			invId: text(header.InvID),
			userToUpdate: text(header.UserToUpdate),
			spDecNo: text(header.SP_DecNo),
			spExpiry: text(header.SP_Expiry),
			spFashion: text(header.SP_Fashion),
			warehouse: text(header.Warehouse),
			dateCount: text(header.Pch_DateCount),
			lastUploadAt: text(sheet.LastUploadAt),
			lastUploadLines: Number(sheet.LastUploadLines ?? 0),
		};
	}

	async counters(): Promise<SheetCounters> {
		const rows = await this.db.select('SELECT updated, COUNT(*) AS n FROM phyDetails GROUP BY updated');
		const by = (state: string) => Number(rows.find((r) => r.updated === state)?.n ?? 0);
		const lines = rows.reduce((sum, r) => sum + Number(r.n), 0);
		return { lines, notCounted: by('0'), pending: by('1'), uploaded: by('2') };
	}

	/** Counted lines not uploaded yet (`updated = '1'`): the D8 upload-first count (§6.1). */
	pendingCount(): Promise<number> {
		return this.db.scalar("SELECT COUNT(*) FROM phyDetails WHERE updated = '1'");
	}

	async getLine(pcdRecId: string): Promise<Line | null> {
		const row = await this.db.get('SELECT * FROM phyDetails WHERE Pcd_RecId = ?', [pcdRecId]);
		return row ? toLine(row) : null;
	}

	private async assertNotLocked(): Promise<void> {
		if (await this.isDownloadInProgress()) throw new SheetLockedError();
	}

	/** Counting write (§5.3): `usercounted = total, updated = '1'` for one line. */
	async setCount(pcdRecId: string, total: Milli): Promise<void> {
		await this.db.inTransaction(async () => {
			await this.assertNotLocked();
			if ((await this.db.scalar('SELECT COUNT(*) FROM phyDetails WHERE Pcd_RecId = ?', [pcdRecId])) !== 1) {
				throw new Error(`Line ${pcdRecId} is not in the downloaded sheet`);
			}
			await this.db.execute("UPDATE phyDetails SET usercounted = ?, updated = '1' WHERE Pcd_RecId = ?", [formatStoredQuantity(total), pcdRecId]);
		});
	}

	/** After InsertDetail answered "ok" for this line (§6.2). */
	async markUploaded(pcdRecId: string): Promise<void> {
		await this.db.execute("UPDATE phyDetails SET updated = '2' WHERE Pcd_RecId = ? AND updated = '1'", [pcdRecId]);
	}

	/** Upload order (§6.2): counted lines not uploaded yet with `_id` above `afterId`, in `_id` order, at most `limit`. */
	async pendingLinesAfter(afterId: number, limit: number): Promise<UploadLine[]> {
		checkedInteger('id', afterId, 0);
		checkedInteger('limit', limit, 1);
		const rows = await this.db.select(
			`SELECT _id, Pcd_RecId, Refernce, usercounted FROM phyDetails WHERE updated = '1' AND _id > ${afterId} ORDER BY _id LIMIT ${limit}`,
		);
		return rows.map((row) => ({ id: Number(row._id), pcdRecId: text(row.Pcd_RecId), reference: text(row.Refernce), counted: parseStoredQuantity(text(row.usercounted)) }));
	}

	/**
	 * Home's "Last upload" (§2.1): kept with the sheet, so the download that replaces the sheet
	 * (INSERT OR REPLACE of the tblSheet row) clears it.
	 */
	async recordUpload(at: string, sent: number): Promise<void> {
		checkedInteger('line count', sent, 1);
		await this.db.execute('UPDATE tblSheet SET LastUploadAt = ?, LastUploadLines = ? WHERE _id = 1', [at, sent]);
	}

	/** Restore uploaded (§2.2): every uploaded line becomes pending again. Returns how many. */
	async restoreUploaded(): Promise<number> {
		return this.db.inTransaction(async () => {
			await this.assertNotLocked();
			const n = await this.db.scalar("SELECT COUNT(*) FROM phyDetails WHERE updated = '2'");
			await this.db.execute("UPDATE phyDetails SET updated = '1' WHERE updated = '2'");
			return n;
		});
	}

	/**
	 * Pick item list (§2.1): lines whose reference starts with `prefix` (ASCII case-insensitive,
	 * `%` and `_` literal), at most `limit`. In RowNumber order, or with `byExpiry` by expiry
	 * (oldest first, lines without a readable expiry last) and then RowNumber.
	 */
	async searchByReferencePrefix(prefix: string, limit: number, options: { byExpiry?: boolean } = {}): Promise<Line[]> {
		checkedInteger('limit', limit, 1);
		const order = options.byExpiry ? `${EXPIRY_ORDER_SQL}, RowNumber` : 'RowNumber';
		const rows = await this.db.select(`SELECT ${LINE_COLUMNS} FROM phyDetails WHERE Refernce LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ${limit}`, [
			likePrefixPattern(prefix),
		]);
		return rows.map(toLine);
	}

	/**
	 * One page of an Items list (§2.1): the lines in one state, in RowNumber order, `limit` rows
	 * starting at `offset`. Served by ix_phyDetails_state_row, so any page costs the same.
	 */
	async listLines(state: '0' | '1' | '2', offset: number, limit: number): Promise<Line[]> {
		checkedInteger('offset', offset, 0);
		checkedInteger('limit', limit, 1);
		const rows = await this.db.select(`SELECT ${LINE_COLUMNS} FROM phyDetails WHERE updated = ? ORDER BY RowNumber LIMIT ${limit} OFFSET ${offset}`, [state]);
		return rows.map(toLine);
	}

	/** The scan lookup over the live sheet (§4.3, §5.2). */
	lookupRepository(): LookupRepository {
		return {
			findByBarcode: async (barcode) => {
				const row = await this.db.get(
					'SELECT d.Pcd_RecId FROM phyBarcodes b JOIN phyDetails d ON d.Pcd_RecId = b.PcBarc_DRecId WHERE b.PcBarc_Barcode = ? ORDER BY b.RowNumber LIMIT 1',
					[barcode],
				);
				return row ? text(row.Pcd_RecId) : null;
			},
			findByReferencePrefix: async (prefix, limit) => {
				// Android binds every parameter as text, which LIMIT may refuse; the limit is a checked integer instead.
				if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid limit ${limit}`);
				const rows = await this.db.select(`SELECT Pcd_RecId FROM phyDetails WHERE Refernce LIKE ? ESCAPE '\\' ORDER BY RowNumber LIMIT ${limit}`, [
					likePrefixPattern(prefix),
				]);
				return rows.map((row) => text(row.Pcd_RecId));
			},
			findByQr: async (stkId, exp, batch) => {
				const row = await this.db.get('SELECT Pcd_RecId FROM phyDetails WHERE Pcd_stkId = ? AND exp = ? AND Pcd_Batch = ? ORDER BY RowNumber LIMIT 1', [
					stkId,
					exp,
					batch,
				]);
				return row ? text(row.Pcd_RecId) : null;
			},
		};
	}
}

/**
 * Counted lines not uploaded yet in a location's database file, for the
 * profile-delete warning (§2.2). Returns 0 without creating a file when the
 * location has no database yet.
 */
export async function pendingCountForLocation(location: string): Promise<number> {
	const fileName = locationDbFileName(location);
	if (!databaseFileExists(fileName)) return 0;
	const db = LocationDb.open(fileName);
	try {
		// Version 0: a file without tables. An older schema version still has phyDetails and its counts.
		if ((await db.userVersion()) < 1) return 0;
		return await db.pendingCount();
	} finally {
		db.close();
	}
}
