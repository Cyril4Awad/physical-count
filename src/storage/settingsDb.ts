import { accept, Check, reject } from '../domain/check';
import { checkLocationCode, checkServerAddress } from '../domain/validation';
import { Database, OpenOptions } from './database';
import { pendingCountForLocation } from './locationDb';

/**
 * Settings database `PhysicalCountSettings` with the location profiles
 * (REBUILD_PLAN §2.2, §4.1): location code + server address, one or none selected.
 */

export const SETTINGS_DB_FILE = 'PhysicalCountSettings';
const SETTINGS_SCHEMA_VERSION = 1;

export interface Profile {
	id: number;
	location: string;
	serverAddress: string;
	selected: boolean;
}

export interface DeleteWarning {
	profile: Profile;
	/** Counted lines not uploaded in that location's database; the database itself is kept (§2.2). */
	pendingCount: number;
}

function toProfile(row: Record<string, unknown>): Profile {
	return {
		id: Number(row._id),
		location: String(row.LocCode),
		serverAddress: String(row.ServerAddress),
		selected: Number(row.Selected) === 1,
	};
}

export class SettingsDb {
	private constructor(private readonly db: Database) {}

	static async open(fileName = SETTINGS_DB_FILE, options: OpenOptions = {}): Promise<SettingsDb> {
		const settings = new SettingsDb(Database.open(fileName, options));
		await settings.ensureSchema();
		return settings;
	}

	close(): void {
		this.db.close();
	}

	private async ensureSchema(): Promise<void> {
		if ((await this.db.userVersion()) >= SETTINGS_SCHEMA_VERSION) return;
		await this.db.inTransaction(async () => {
			await this.db.execute(
				'CREATE TABLE IF NOT EXISTS tblProfiles(_id INTEGER PRIMARY KEY, LocCode TEXT NOT NULL, ServerAddress TEXT NOT NULL, Selected INTEGER NOT NULL DEFAULT 0)',
			);
			// The same location twice is refused whatever the case (V2 / v2); the code itself is kept as typed.
			await this.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_loc ON tblProfiles(LocCode COLLATE NOCASE)');
			// At most one selected profile, enforced by the database as well.
			await this.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_selected ON tblProfiles(Selected) WHERE Selected = 1');
		});
		await this.db.setUserVersion(SETTINGS_SCHEMA_VERSION);
	}

	async listProfiles(): Promise<Profile[]> {
		return (await this.db.select('SELECT * FROM tblProfiles ORDER BY LocCode COLLATE NOCASE')).map(toProfile);
	}

	async getProfile(id: number): Promise<Profile | null> {
		const row = await this.db.get('SELECT * FROM tblProfiles WHERE _id = ?', [id]);
		return row ? toProfile(row) : null;
	}

	async selectedProfile(): Promise<Profile | null> {
		const row = await this.db.get('SELECT * FROM tblProfiles WHERE Selected = 1');
		return row ? toProfile(row) : null;
	}

	private async duplicateOf(location: string, exceptId: number): Promise<boolean> {
		return (await this.db.scalar('SELECT COUNT(*) FROM tblProfiles WHERE LocCode = ? COLLATE NOCASE AND _id <> ?', [location, exceptId])) > 0;
	}

	private async checkFields(location: string, serverAddress: string, exceptId: number): Promise<Check<{ location: string; serverAddress: string }>> {
		const loc = checkLocationCode(location);
		if (!loc.ok) return loc;
		const server = checkServerAddress(serverAddress);
		if (!server.ok) return server;
		if (await this.duplicateOf(loc.value, exceptId)) return reject(`Location ${loc.value} already has a profile.`);
		return accept({ location: loc.value, serverAddress: server.value });
	}

	/** Adds a profile; with `select`, it also becomes the selected one, in the same transaction. */
	async addProfile(location: string, serverAddress: string, options: { select?: boolean } = {}): Promise<Check<Profile>> {
		return this.db.inTransaction(async () => {
			const fields = await this.checkFields(location, serverAddress, 0);
			if (!fields.ok) return fields;
			if (options.select) await this.db.execute('UPDATE tblProfiles SET Selected = 0 WHERE Selected = 1');
			await this.db.execute('INSERT INTO tblProfiles(LocCode, ServerAddress, Selected) VALUES (?, ?, ?)', [
				fields.value.location,
				fields.value.serverAddress,
				options.select ? 1 : 0,
			]);
			const id = await this.db.scalar('SELECT last_insert_rowid()');
			return accept((await this.getProfile(id)) as Profile);
		});
	}

	async editProfile(id: number, location: string, serverAddress: string): Promise<Check<Profile>> {
		return this.db.inTransaction(async () => {
			if (!(await this.getProfile(id))) return reject('This profile no longer exists.');
			const fields = await this.checkFields(location, serverAddress, id);
			if (!fields.ok) return fields;
			await this.db.execute('UPDATE tblProfiles SET LocCode = ?, ServerAddress = ? WHERE _id = ?', [fields.value.location, fields.value.serverAddress, id]);
			return accept((await this.getProfile(id)) as Profile);
		});
	}

	/** Makes `id` the only selected profile, in one transaction (exactly one selected afterwards). */
	async selectProfile(id: number): Promise<Check<Profile>> {
		return this.db.inTransaction(async () => {
			if (!(await this.getProfile(id))) return reject('This profile no longer exists.');
			await this.db.execute('UPDATE tblProfiles SET Selected = 0 WHERE Selected = 1');
			await this.db.execute('UPDATE tblProfiles SET Selected = 1 WHERE _id = ?', [id]);
			const selected = await this.db.scalar('SELECT COUNT(*) FROM tblProfiles WHERE Selected = 1');
			if (selected !== 1) throw new Error(`Profile switch left ${selected} profiles selected`);
			return accept((await this.getProfile(id)) as Profile);
		});
	}

	/** What to tell the operator before deleting: counted lines not uploaded at that location. */
	async deleteWarning(id: number): Promise<DeleteWarning | null> {
		const profile = await this.getProfile(id);
		if (!profile) return null;
		return { profile, pendingCount: await pendingCountForLocation(profile.location) };
	}

	/**
	 * Deletes the profile only. The location's database is kept, so re-adding the
	 * same location finds its sheet and counts again. Deleting the selected
	 * profile leaves no profile selected.
	 */
	async deleteProfile(id: number): Promise<void> {
		await this.db.execute('DELETE FROM tblProfiles WHERE _id = ?', [id]);
	}
}
