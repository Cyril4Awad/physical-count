/**
 * Tunable constants, kept in one place so they can change after the handheld
 * test (REBUILD_PLAN Q13, §3.1). Pure module: no NativeScript imports.
 */

/** Default download page size (Q13); the operator can change it in Settings (1–5000). */
export const DEFAULT_PAGE_SIZE = 1000;

/** Run location-database statements on the SQLite plugin's background thread (Q13, §4.4). */
export const DOWNLOAD_BACKGROUND_THREAD = true;

/** SOAP timeouts per method (§3.1). */
export const SOAP_TIMEOUT_MS = {
	InitPullTables: 120_000,
	pullRecords: 30_000,
	InsertDetail: 30_000,
} as const;

/** Settings → Test connection: GET …/Service1.asmx?WSDL (§2.2). */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
