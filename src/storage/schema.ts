/**
 * Local SQLite schema for one location database (REBUILD_PLAN §4.2).
 *
 * Every table and column name used in SQL comes from the constants in this
 * file, never from text sent by the service (D7). Pure module: no NativeScript
 * imports, so it can be used by Node unit tests.
 */

export type PhyTable = 'phyHeader' | 'phyDetails' | 'phyBarcodes';

export const PHY_TABLES: readonly PhyTable[] = ['phyHeader', 'phyDetails', 'phyBarcodes'];

/**
 * Column lists exactly as the service's `InsertInto` sends them (§3.5.1), in
 * that order. `_id` is not included: SQLite assigns it.
 */
export const COLUMNS: Readonly<Record<PhyTable, readonly string[]>> = {
	phyHeader: [
		'RowNumber',
		'Pch_Recid',
		'Warehouse',
		'Pch_DateCount',
		'Pch_MachUser1',
		'Pch_MachUser2',
		'Pch_MachUser3',
		'Pch_MachUser4',
		'Pch_MachUser5',
		'Pch_MachUser6',
		'Pch_Status',
		'Pch_Updated',
		'Pch_NbrItems',
		'UserToUpdate',
		'SP_DecNo',
		'SP_Fashion',
		'SP_Expiry',
		'updated',
		'InvID',
	],
	phyDetails: [
		'RowNumber',
		'Pcd_RecId',
		'Pcd_Loc',
		'Pcd_stkId',
		'Refernce',
		'stk_Desc',
		'Pcd_Grid',
		'Pcd_DetGrid',
		'Pcd_Color',
		'Color_Desc',
		'exp',
		'Pcd_Batch',
		'Pcd_DateCount',
		'Pcd_Qty',
		'Pcd_QtyCounted1',
		'Pcd_Type1',
		'Pcd_QtyCounted2',
		'Pcd_Type2',
		'Pcd_QtyCounted3',
		'Pcd_Type3',
		'Pcd_QtyCounted4',
		'Pcd_Type4',
		'Pcd_QtyCounted5',
		'Pcd_Type5',
		'Pcd_QtyCounted6',
		'Pcd_Type6',
		'usercounted',
		'updated',
	],
	phyBarcodes: ['RowNumber', 'PcBarc_RecId', 'PcBarc_DRecId', 'PcBarc_Barcode', 'updated'],
};

export type StagingTable = `stg_${PhyTable}`;

export function stagingTable(table: PhyTable): StagingTable {
	return `stg_${table}`;
}

/**
 * 2 (step 8): adds ix_phyDetails_state_row for the Items lists. Every statement is
 * `IF NOT EXISTS`, so a version 1 database is upgraded by running them again.
 * 3 (step 9): adds the SHEET_V3_COLUMNS to tblSheet.
 */
export const SCHEMA_VERSION = 3;

/**
 * tblSheet remembers the last upload run that sent at least one line (Home, §2.1).
 * A new database gets these columns from CREATE TABLE; an older one gets them with ALTER TABLE.
 */
export const SHEET_V3_COLUMNS: readonly (readonly [string, string])[] = [
	['LastUploadAt', 'TEXT'],
	['LastUploadLines', 'INTEGER'],
];

function createPhyTable(name: string, table: PhyTable): string {
	const columns = COLUMNS[table].map((column) => (column === 'RowNumber' ? 'RowNumber INTEGER NOT NULL' : `${column} TEXT`));
	return `CREATE TABLE IF NOT EXISTS ${name}(_id INTEGER PRIMARY KEY, ${columns.join(', ')})`;
}

function indexStatements(name: string, table: PhyTable): string[] {
	const statements = [`CREATE UNIQUE INDEX IF NOT EXISTS ix_${name}_RowNumber ON ${name}(RowNumber)`];
	if (table === 'phyDetails') {
		statements.push(
			`CREATE UNIQUE INDEX IF NOT EXISTS ix_${name}_RecId ON ${name}(Pcd_RecId)`,
			`CREATE INDEX IF NOT EXISTS ix_${name}_Ref ON ${name}(Refernce COLLATE NOCASE)`,
			`CREATE INDEX IF NOT EXISTS ix_${name}_updated ON ${name}(updated)`,
			`CREATE INDEX IF NOT EXISTS ix_${name}_qr ON ${name}(Pcd_stkId, exp, Pcd_Batch)`,
		);
		// Items lists (§2.1): one line state in RowNumber order, any page, without sorting. Live table only.
		if (name === table) statements.push(`CREATE INDEX IF NOT EXISTS ix_${name}_state_row ON ${name}(updated, RowNumber)`);
	}
	if (table === 'phyBarcodes') {
		statements.push(`CREATE INDEX IF NOT EXISTS ix_${name}_Barcode ON ${name}(PcBarc_Barcode)`);
	}
	return statements;
}

/** All statements that create the current schema version, in order. */
export function createSchemaStatements(): string[] {
	const statements: string[] = [];
	for (const table of PHY_TABLES) {
		for (const name of [table, stagingTable(table)]) {
			statements.push(createPhyTable(name, table), ...indexStatements(name, table));
		}
	}
	statements.push(
		'CREATE TABLE IF NOT EXISTS tblPullStatus(_id INTEGER PRIMARY KEY, CountNumber TEXT, SelectedLocation TEXT, MachineName TEXT, ' +
			'TableName TEXT, OriginalTableName TEXT, PullDisplayHeader TEXT, RowsCount INTEGER, RowsStored INTEGER, ' +
			'PullFinished INTEGER, Columns TEXT, StartedAt TEXT)',
		'CREATE TABLE IF NOT EXISTS tblSheet(_id INTEGER PRIMARY KEY CHECK (_id = 1), CountNumber TEXT, MachineName TEXT, DownloadedAt TEXT, ' +
			`${SHEET_V3_COLUMNS.map(([name, type]) => `${name} ${type}`).join(', ')})`,
	);
	return statements;
}

/** `INSERT` for one page of rows, built only from the constants above. */
export function insertStatement(target: PhyTable | StagingTable, table: PhyTable): string {
	const columns = COLUMNS[table];
	return `INSERT INTO ${target}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
}
