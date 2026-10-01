import { Utils } from '@nativescript/core';
import { deleteDatabase, openOrCreate, SQLiteDatabase } from '@nativescript-community/sqlite';

/** One result row, by column name (the plugin's own row type is not exported from its entry point). */
export type SqliteRow = Record<string, any>;

/**
 * Thin wrapper over @nativescript-community/sqlite shared by the settings and
 * location databases (REBUILD_PLAN §4).
 *
 * Transactions are run as `BEGIN` / `COMMIT` / `ROLLBACK` statements through
 * `execute()`, not with the plugin's `transaction()`. Android binds a
 * transaction to the thread that began it; with `threading: true` the plugin
 * runs every statement on its worker thread but `transaction()` would begin on
 * the UI thread, which deadlocks. Statements sent in order all run on the same
 * thread in both modes. `user_version` is read and written the same way.
 */

const FILE_NAME = /^[A-Za-z0-9_]{1,64}$/;

export interface OpenOptions {
	/** Run statements on the plugin's worker thread instead of the UI thread (Q13). */
	threading?: boolean;
}

/** Android's standard database folder for the app (`/data/data/<id>/databases/<name>`). */
export function databasePath(fileName: string): string {
	if (!FILE_NAME.test(fileName)) throw new Error(`Invalid database file name "${fileName}"`);
	const file: java.io.File = Utils.android.getApplicationContext().getDatabasePath(fileName);
	file.getParentFile().mkdirs();
	return file.getAbsolutePath();
}

export function databaseFileExists(fileName: string): boolean {
	return new java.io.File(databasePath(fileName)).exists();
}

export function deleteDatabaseFile(fileName: string): void {
	deleteDatabase(databasePath(fileName));
}

/** The worker thread reports failures as plain strings; turn them into Errors so both modes fail the same way. */
async function asError<T>(promise: Promise<T>): Promise<T> {
	try {
		return await promise;
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}

export class Database {
	private inTransactionNow = false;

	private constructor(
		private readonly db: SQLiteDatabase,
		readonly fileName: string,
	) {}

	static open(fileName: string, options: OpenOptions = {}): Database {
		return new Database(openOrCreate(databasePath(fileName), { threading: options.threading === true }), fileName);
	}

	close(): void {
		this.db.close();
	}

	execute(sql: string, params?: unknown[]): Promise<void> {
		return asError(this.db.execute(sql, params));
	}

	select(sql: string, params?: unknown[]): Promise<SqliteRow[]> {
		return asError(this.db.select(sql, params));
	}

	async get(sql: string, params?: unknown[]): Promise<SqliteRow | null> {
		return (await asError(this.db.get(sql, params))) ?? null;
	}

	async scalar(sql: string, params?: unknown[]): Promise<number> {
		const row = await this.get(sql, params);
		const value = row ? Object.values(row)[0] : null;
		return Number(value ?? 0);
	}

	async userVersion(): Promise<number> {
		return this.scalar('PRAGMA user_version');
	}

	/** `version` is a constant from the schema modules, never user input. */
	setUserVersion(version: number): Promise<void> {
		if (!Number.isInteger(version) || version < 0) throw new Error(`Invalid schema version ${version}`);
		return this.execute(`PRAGMA user_version = ${version}`);
	}

	/** Runs `action` in one transaction: committed if it resolves, rolled back if it throws. Not re-entrant. */
	async inTransaction<T>(action: () => Promise<T>): Promise<T> {
		if (this.inTransactionNow) throw new Error('Nested transaction');
		this.inTransactionNow = true;
		try {
			await this.execute('BEGIN IMMEDIATE');
			let result: T;
			try {
				result = await action();
			} catch (error) {
				await this.execute('ROLLBACK').catch(() => undefined);
				throw error;
			}
			await this.execute('COMMIT');
			return result;
		} finally {
			this.inTransactionNow = false;
		}
	}
}
