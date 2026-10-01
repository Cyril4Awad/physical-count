/** Shared fixtures for on-device tests: the saved SOAP samples and fake page sources. */
import { buildManifest, ManifestEntry } from '../parse/manifest';
import { PullRecordsResult, readInitPullTables, readPullRecords } from '../soap/responses';
import type { FetchPage, PageRequest } from '../storage/download';

declare const require: any;
const samples = require.context('../../docs/service-samples', false, /\.response\.xml$/);

export function sample(name: string): string {
	const loaded = samples(`./${name}`);
	return typeof loaded === 'string' ? loaded : loaded.default;
}

export function manifestEntries(name: string, location: string, machine: string): ManifestEntry[] {
	const result = readInitPullTables(sample(name));
	if (result.kind !== 'tables') throw new Error('expected tables');
	const manifest = buildManifest(result.tables, location, machine);
	if (manifest.kind !== 'ok') throw new Error('expected a downloadable count');
	return manifest.entries;
}

export function records(name: string): string[] {
	const result = readPullRecords(sample(name));
	return result.kind === 'records' ? result.valuesQueries : [];
}

const COUNT9_PAGES: Record<string, string> = {
	'_ERPDATACOLLECTOR_tbl_PhysicalCountHeader_V2UN3@1': 'pullRecords.count9-V2-UN3.phyHeader.from1.response.xml',
	'_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3@1': 'pullRecords.count9-V2-UN3.phyDetails.from1.response.xml',
	'_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3@51': 'pullRecords.count9-V2-UN3.phyDetails.from51.response.xml',
	'_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3@101': 'pullRecords.count9-V2-UN3.phyDetails.from101.response.xml',
	'_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3@103': 'pullRecords.count9-V2-UN3.phyDetails.from103-past-end.response.xml',
	'_ERPDATACOLLECTOR_tbl_PhysicalCountDetBarcode_V2UN3@1': 'pullRecords.count9-V2-UN3.phyBarcodes.empty.response.xml',
};

/**
 * Count 9 / V2 / UN3 served from the saved samples (use page size 50, as the
 * samples were taken with it). Records every request; `hook` can replace or
 * fail a page.
 */
export function count9Source(hook?: (request: PageRequest, callNumber: number) => PullRecordsResult | 'fail' | undefined) {
	const requests: PageRequest[] = [];
	const fetchPage: FetchPage = async (request) => {
		requests.push(request);
		const override = hook?.(request, requests.length);
		if (override === 'fail') throw new Error('Simulated network failure');
		if (override) return override;
		const name = COUNT9_PAGES[`${request.tableName}@${request.startFromRow}`];
		if (!name) throw new Error(`No sample for ${request.tableName} from ${request.startFromRow}`);
		return readPullRecords(sample(name));
	};
	return { fetchPage, requests };
}

export function recordsResponse(valuesQueries: string[]): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
		'<pullRecordsResponse xmlns="http://tempuri.org/"><pullRecordsResult><mRecords>' +
		valuesQueries.map((v) => `<Record><valuesquery>${v}</valuesquery></Record>`).join('') +
		'</mRecords></pullRecordsResult></pullRecordsResponse></soap:Body></soap:Envelope>'
	);
}

export const COUNT10_LINES = 11131;

/**
 * A count-10-sized download (CV / UN, 11,131 lines) built from count 10's real
 * first detail row: RowNumber n gets Pcd_RecId 900000000 + n. Pages are real
 * SOAP XML, parsed by the same reader as a live response. The header comes
 * from count 9 (there is no count 10 header sample; same columns); barcodes
 * are count 10's real 9 rows.
 */
export function count10SizedSource() {
	const detailTemplate = records('pullRecords.count10-CV-UN.phyDetails.from1.response.xml')[0].split(',').slice(2).join(',');
	const header = records('pullRecords.count9-V2-UN3.phyHeader.from1.response.xml');
	const barcodes = records('pullRecords.count10-CV-UN.phyBarcodes.from1.response.xml');
	const fetchPage: FetchPage = async ({ tableName, pageSize, startFromRow }) => {
		if (tableName.includes('Header')) return readPullRecords(recordsResponse(startFromRow === 1 ? header : []));
		if (tableName.includes('DetBarcode')) return readPullRecords(recordsResponse(startFromRow === 1 ? barcodes : []));
		const rows: string[] = [];
		for (let n = startFromRow; n < startFromRow + pageSize && n <= COUNT10_LINES; n++) rows.push(`'${n}','${900000000 + n}',${detailTemplate}`);
		return readPullRecords(recordsResponse(rows));
	};
	return fetchPage;
}
