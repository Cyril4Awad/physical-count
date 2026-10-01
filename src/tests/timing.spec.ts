/**
 * Step 3 timing (REBUILD_PLAN Q13): a count-10-sized download (11,131 lines)
 * through the real storage path (staging, RowsStored, swap), with the SQLite
 * plugin's background-thread option off and on, at 1000- and 5000-row pages.
 *
 * "Longest UI block" is the longest gap seen by a 5 ms timer on the UI thread
 * while the download runs: how long the screen would freeze at worst.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { toPageRows } from '../parse/rows';
import { readPullRecords } from '../soap/responses';
import { runDownload } from '../storage/download';
import { deleteLocationDbFile, LocationDb } from '../storage/locationDb';
import { COUNT10_LINES, count10SizedSource, manifestEntries, recordsResponse } from './helpers';

const FILE = 'ERPDataCollectorNDB_TIMING';
const ENTRIES = manifestEntries('InitPullTables.count10-CV-UN.response.xml', 'CV', 'UN');
const results: string[] = [];

function uiTicker() {
	let last = Date.now();
	let longest = 0;
	const timer = setInterval(() => {
		const now = Date.now();
		longest = Math.max(longest, now - last);
		last = now;
	}, 5);
	return () => {
		clearInterval(timer);
		return Math.max(longest, Date.now() - last);
	};
}

afterAll(() => {
	deleteLocationDbFile(FILE);
	console.log(`[step 3 timing: ${COUNT10_LINES} lines, emulator]\n${results.join('\n')}`);
});

describe('page timing, background thread off and on (Q13)', () => {
	it.each([1000, 5000])('parsing one %i-row page (UI thread in both modes)', async (pageSize) => {
		const fetchPage = count10SizedSource();
		const t0 = Date.now();
		const response = await fetchPage({ tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_CVUN', pageSize, startFromRow: 1 });
		const t1 = Date.now();
		if (response.kind !== 'records') throw new Error('expected records');
		const rows = toPageRows(ENTRIES[1].columnMap, response.valuesQueries);
		const t2 = Date.now();
		expect(rows).toHaveLength(pageSize);
		const kb = (recordsResponse(response.valuesQueries).length / 1024).toFixed(0);
		results.push(`parse ${pageSize}-row page (${kb} KB XML): XML read ${t1 - t0} ms, rows ${t2 - t1} ms`);
	});

	it.each([
		[false, 1000],
		[false, 5000],
		[true, 1000],
		[true, 5000],
	])(
		'threading %s, page size %i',
		async (threading, pageSize) => {
			deleteLocationDbFile(FILE);
			const db = LocationDb.open(FILE, { threading });
			try {
				await db.ensureSchema();
				await db.startDownload('10', 'CV', 'UN', ENTRIES);
				const fetchPage = count10SizedSource();
				let pages = 0;
				const stopTicker = uiTicker();
				const t0 = Date.now();
				const outcome = await runDownload(db, fetchPage, { pageSize, onProgress: () => pages++ });
				const total = Date.now() - t0;
				const longestBlock = stopTicker();

				expect(outcome).toEqual({ kind: 'completed' });
				expect(await db.count('phyDetails')).toBe(COUNT10_LINES);
				expect(await db.count('phyBarcodes')).toBe(9);
				const detailPages = Math.ceil(COUNT10_LINES / pageSize);
				results.push(
					`threading ${threading ? 'on ' : 'off'}, ${pageSize}-row pages: total ${(total / 1000).toFixed(1)} s ` +
						`(${pages} pages, ~${Math.round(total / detailPages)} ms per details page incl. parse), longest UI block ${longestBlock} ms`,
				);
			} finally {
				db.close();
			}
		},
		900_000,
	);
});
