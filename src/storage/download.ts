import type { PullRecordsResult } from '../soap/responses';
import { toPageRows } from '../parse/rows';
import type { LocationDb, PullStatus } from './locationDb';

/**
 * Paging loop of a staged download (REBUILD_PLAN §3.4, §6.1 steps 5–6). The
 * same loop serves a new download (after `startDownload`) and Continue
 * download: it always asks for `RowsStored + 1`. The page source is injected;
 * step 4 plugs in the SOAP client.
 */

export interface PageRequest {
	tableName: string;
	pageSize: number;
	startFromRow: number;
}

export type FetchPage = (request: PageRequest) => Promise<PullRecordsResult>;

export interface PageProgress {
	table: PullStatus['table'];
	displayHeader: string;
	rowsStored: number;
	rowsCount: number;
}

export type DownloadOutcome =
	| { kind: 'completed' }
	| { kind: 'cancelled' }
	/** The server returned no new rows before RowsCount was reached (§3.4 stop rule). */
	| { kind: 'stalled'; table: PullStatus['table']; rowsStored: number; rowsCount: number };

/** Time spent per phase, summed over pages (ms). Filled in when passed to runDownload. */
export interface DownloadStats {
	pages: number;
	/** fetchPage: network plus reading the XML (the page source may split this further). */
	fetchMs: number;
	/** valuesquery strings → rows (tokenize, check, sort). */
	parseMs: number;
	/** storePage: staging insert + RowsStored, one transaction per page. */
	storeMs: number;
	/** The final swap into the live sheet. */
	applyMs: number;
}

export function emptyStats(): DownloadStats {
	return { pages: 0, fetchMs: 0, parseMs: 0, storeMs: 0, applyMs: 0 };
}

export interface DownloadOptions {
	pageSize: number;
	/** Checked before every page (§6.1 Cancel). */
	shouldCancel?: () => boolean;
	onProgress?: (progress: PageProgress) => void;
	stats?: DownloadStats;
}

/** Gives the UI thread a turn between pages, so progress and Cancel stay responsive (§14 step 6). */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Pages every unfinished table into staging, then swaps it into the live sheet.
 * Errors (network, parse, database) propagate and leave the download resumable;
 * the live sheet changes only in the final `applyDownload`.
 */
export async function runDownload(db: LocationDb, fetchPage: FetchPage, options: DownloadOptions): Promise<DownloadOutcome> {
	for (;;) {
		const next = (await db.pullStatus()).find((status) => !status.finished);
		if (!next) {
			const t = Date.now();
			await db.applyDownload();
			if (options.stats) options.stats.applyMs += Date.now() - t;
			return { kind: 'completed' };
		}
		if (options.shouldCancel?.()) return { kind: 'cancelled' };

		const t0 = Date.now();
		const result = await fetchPage({ tableName: next.tableName, pageSize: options.pageSize, startFromRow: next.rowsStored + 1 });
		const t1 = Date.now();
		const rows = result.kind === 'records' ? toPageRows(next.columnMap, result.valuesQueries) : [];
		const t2 = Date.now();
		const stored = await db.storePage(next.table, rows);
		if (options.stats) {
			options.stats.pages++;
			options.stats.fetchMs += t1 - t0;
			options.stats.parseMs += t2 - t1;
			options.stats.storeMs += Date.now() - t2;
		}
		options.onProgress?.({ table: next.table, displayHeader: next.displayHeader, rowsStored: stored.rowsStored, rowsCount: next.rowsCount });

		if (stored.inserted === 0 && !stored.finished) {
			return { kind: 'stalled', table: next.table, rowsStored: stored.rowsStored, rowsCount: next.rowsCount };
		}
		await yieldToUi();
	}
}
