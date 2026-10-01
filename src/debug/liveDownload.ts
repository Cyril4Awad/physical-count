/**
 * DEBUG ONLY — step 4 live check (REBUILD_PLAN §14 step 4). No app screens.
 * Built only with `npm run debug:live-download` (webpack env.liveDownload, never
 * in a release build). Downloads counts 9 (V2 / UN3) and 10 (CV / UN) from the
 * local service at 10.0.2.2 through the real client, staged download, resume and
 * swap, logs progress to logcat ("[live-download]") and ends with RESULT PASS/FAIL.
 * Never calls InsertDetail.
 */
import { Application, Label, Page } from '@nativescript/core';
import { DEFAULT_PAGE_SIZE, DOWNLOAD_BACKGROUND_THREAD } from '../config';
import { buildManifest } from '../parse/manifest';
import { tokenizeValuesQuery } from '../parse/valuesQuery';
import { pageSourceFor, SoapCallError, SoapClient } from '../soap/client';
import { formatDeviceInfo } from '../soap/envelopes';
import { httpTransport } from '../soap/httpTransport';
import type { Transport } from '../soap/client';
import { readPullRecords } from '../soap/responses';
import { DownloadStats, emptyStats, runDownload } from '../storage/download';
import { LocationDb, locationDbFileName } from '../storage/locationDb';
import { COLUMNS, PHY_TABLES, PhyTable } from '../storage/schema';

declare const require: any;
const samples = require.context('../../docs/service-samples', false, /\.response\.xml$/);

const SERVER = '10.0.2.2';
const log = (message: string) => console.log(`[live-download] ${message}`);

interface Case {
	countNumber: string;
	location: string;
	machine: string;
	expected: [number, number, number];
	/** Cancel after this many pages, close and reopen the database, then Continue download (§6.1 resume). */
	interruptAfterPages?: number;
	/** Saved samples whose rows must come back identical (except the counted columns, which can change). */
	sameAs: { table: PhyTable; sample: string }[];
}

const CASES: Case[] = [
	{
		countNumber: '9',
		location: 'V2',
		machine: 'UN3',
		expected: [1, 102, 0],
		sameAs: [
			{ table: 'phyHeader', sample: 'pullRecords.count9-V2-UN3.phyHeader.from1.response.xml' },
			{ table: 'phyDetails', sample: 'pullRecords.count9-V2-UN3.phyDetails.from1.response.xml' },
			{ table: 'phyDetails', sample: 'pullRecords.count9-V2-UN3.phyDetails.from51.response.xml' },
			{ table: 'phyDetails', sample: 'pullRecords.count9-V2-UN3.phyDetails.from101.response.xml' },
		],
	},
	{
		countNumber: '10',
		location: 'CV',
		machine: 'UN',
		expected: [1, 11131, 9],
		interruptAfterPages: 4,
		sameAs: [
			{ table: 'phyDetails', sample: 'pullRecords.count10-CV-UN.phyDetails.from1.response.xml' },
			{ table: 'phyBarcodes', sample: 'pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml' },
		],
	},
];

/** Columns a count or an upload can change on the server since the samples were saved. */
const CHANGING = new Set(['usercounted', 'Pcd_DateCount', ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`Pcd_QtyCounted${n}`, `Pcd_Type${n}`])]);

function sampleRows(name: string): string[][] {
	const loaded = samples(`./${name}`);
	const result = readPullRecords(typeof loaded === 'string' ? loaded : loaded.default);
	return result.kind === 'records' ? result.valuesQueries.map(tokenizeValuesQuery) : [];
}

async function compareWithSamples(db: LocationDb, check: Case['sameAs'][number], failures: string[]): Promise<void> {
	const rows = await db.selectAll(check.table);
	const byRowNumber = new Map(rows.map((row) => [Number(row.RowNumber), row]));
	const columns = COLUMNS[check.table];
	let compared = 0;
	const changed: string[] = [];
	for (const values of sampleRows(check.sample)) {
		const row = byRowNumber.get(Number(values[0]));
		if (!row) {
			failures.push(`${check.table} row ${values[0]} from ${check.sample} is missing`);
			continue;
		}
		columns.forEach((column, i) => {
			const stored = row[column] === null || row[column] === undefined ? '' : String(row[column]);
			if (stored === values[i]) return;
			if (CHANGING.has(column)) changed.push(`${check.table} row ${values[0]} ${column}: sample '${values[i]}', now '${stored}'`);
			else failures.push(`${check.table} row ${values[0]} ${column}: sample '${values[i]}', downloaded '${stored}'`);
		});
		compared++;
	}
	log(`  ${check.sample}: ${compared} rows compared with the saved sample`);
	changed.forEach((c) => log(`  note (count columns may change on the server): ${c}`));
}

/** Wraps the device transport to add up time on the network (request sent → body received). */
function timedTransport(): { transport: Transport; networkMs: () => number; reset: () => void } {
	let total = 0;
	return {
		transport: async (request) => {
			const t = Date.now();
			try {
				return await httpTransport(request);
			} finally {
				total += Date.now() - t;
			}
		},
		networkMs: () => total,
		reset: () => {
			total = 0;
		},
	};
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function logStats(stats: DownloadStats, pageNetworkMs: number, pagingMs: number): void {
	const other = pagingMs - stats.fetchMs - stats.parseMs - stats.storeMs - stats.applyMs;
	log(
		`  paging split over ${stats.pages} pages: network ${seconds(pageNetworkMs)}, XML read ${seconds(stats.fetchMs - pageNetworkMs)}, ` +
			`row parsing ${seconds(stats.parseMs)}, storage ${seconds(stats.storeMs)}, swap ${seconds(stats.applyMs)}, ` +
			`between pages (manifest reads, UI yield, resume reopen) ${seconds(other)}`,
	);
}

async function runCase(test: Case): Promise<string[]> {
	const failures: string[] = [];
	const label = `count ${test.countNumber} / ${test.location} / ${test.machine}`;
	log(`── ${label}: expecting ${test.expected.join(' / ')} rows (header / details / barcodes)`);

	const fileName = locationDbFileName(test.location);
	let db = LocationDb.open(fileName, { threading: DOWNLOAD_BACKGROUND_THREAD });
	try {
		await db.ensureSchema();
		const pending = await db.pendingCount();
		if (pending > 0) return [`${label}: ${pending} counted lines not uploaded in ${fileName}; not discarding them (D8)`];
		if (await db.isDownloadInProgress()) {
			log('  a previous download was in progress; abandoning it');
			await db.abandonDownload();
		}

		const timed = timedTransport();
		const client = new SoapClient(SERVER, timed.transport);
		const deviceInfo = formatDeviceInfo({ model: android.os.Build.MODEL, manufacturer: android.os.Build.MANUFACTURER, brand: android.os.Build.BRAND });
		const t0 = Date.now();
		const init = await client.initPullTables({ location: test.location, machine: test.machine, countNumber: test.countNumber, deviceInfo });
		const initMs = Date.now() - t0;
		if (init.kind !== 'ok') return [`${label}: InitPullTables ${init.kind}: ${init.message}${'detail' in init ? ` (${init.detail})` : ''}`];
		const manifest = buildManifest(init.value, test.location, test.machine);
		if (manifest.kind !== 'ok') return [`${label}: not downloadable`];
		log(`  InitPullTables: ${seconds(initMs)} (network ${seconds(timed.networkMs())}); ${manifest.entries.map((e) => `${e.originalTableName} ${e.rowsCount}`).join(', ')}`);
		await db.startDownload(test.countNumber, test.location, test.machine, manifest.entries);

		timed.reset();
		const stats = emptyStats();
		const fetchPage = pageSourceFor(client);
		let pages = 0;
		const onProgress = (p: { table: string; rowsStored: number; rowsCount: number }) => {
			pages++;
			log(`  page ${pages}: ${p.table} ${p.rowsStored} / ${p.rowsCount}`);
		};
		const t1 = Date.now();
		if (test.interruptAfterPages) {
			const first = await runDownload(db, fetchPage, { pageSize: DEFAULT_PAGE_SIZE, onProgress, stats, shouldCancel: () => pages >= (test.interruptAfterPages ?? 0) });
			if (first.kind !== 'cancelled') failures.push(`${label}: expected the interrupted run to be cancelled, got ${first.kind}`);
			const stored = (await db.pullStatus()).map((s) => `${s.table} ${s.rowsStored}`).join(', ');
			log(`  interrupted after ${pages} pages (${stored}); closing and reopening the database, then Continue download`);
			db.close();
			db = LocationDb.open(fileName, { threading: DOWNLOAD_BACKGROUND_THREAD });
			await db.ensureSchema();
		}
		const outcome = await runDownload(db, fetchPage, { pageSize: DEFAULT_PAGE_SIZE, onProgress, stats });
		const pagingMs = Date.now() - t1;
		if (outcome.kind !== 'completed') return [...failures, `${label}: download ${outcome.kind}`];

		const counts = await Promise.all(PHY_TABLES.map((t) => db.count(t)));
		log(`  downloaded ${counts.join(' / ')} in ${pages} pages of up to ${DEFAULT_PAGE_SIZE}; paging ${seconds(pagingMs)}, total ${seconds(initMs + pagingMs)}`);
		logStats(stats, timed.networkMs(), pagingMs);
		if (counts.join() !== test.expected.join()) failures.push(`${label}: rows ${counts.join(' / ')}, expected ${test.expected.join(' / ')}`);
		if (await db.isDownloadInProgress()) failures.push(`${label}: staging not cleared after the swap`);
		const staged = await Promise.all(PHY_TABLES.map((t) => db.count(`stg_${t}`)));
		if (staged.some((n) => n !== 0)) failures.push(`${label}: staging tables still hold ${staged.join(' / ')} rows`);
		const sheet = await db.sheetInfo();
		log(`  sheet: count ${sheet?.countNumber}, InvID ${sheet?.invId}, slot ${sheet?.userToUpdate}, SP_DecNo ${sheet?.spDecNo}, SP_Expiry ${sheet?.spExpiry}`);
		for (const check of test.sameAs) await compareWithSamples(db, check, failures);
		log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${label}: rows ${counts.join(' / ')} (expected ${test.expected.join(' / ')})`);
		return failures;
	} catch (error) {
		const text = error instanceof SoapCallError ? `${error.failure.kind}: ${error.message}${'detail' in error.failure ? ` (${error.failure.detail})` : ''}` : String(error);
		return [...failures, `${label}: ${text}`];
	} finally {
		db.close();
	}
}

async function main(): Promise<void> {
	log(`start: server ${SERVER}, page size ${DEFAULT_PAGE_SIZE}, background thread ${DOWNLOAD_BACKGROUND_THREAD ? 'on' : 'off'}`);
	const failures: string[] = [];
	for (const test of CASES) failures.push(...(await runCase(test)));
	failures.forEach((f) => log(`FAIL ${f}`));
	log(`RESULT ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
}

Application.run({
	create: () => {
		const page = new Page();
		const label = new Label();
		label.text = 'Debug live download check.\nResults are in logcat: [live-download]';
		label.textWrap = true;
		label.padding = 24;
		page.content = label;
		setTimeout(() => void main(), 500);
		return page;
	},
});
