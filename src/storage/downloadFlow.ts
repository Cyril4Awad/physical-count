import { ServiceDataError } from '../parse/errors';
import { buildManifest, ManifestEntry, NotDownloadableReason } from '../parse/manifest';
import { SoapCallError, SoapClient, SoapFailure } from '../soap/client';
import type { LocationDb } from './locationDb';

/**
 * Start of a download (REBUILD_PLAN §3.3, §6.1 steps 3–4): InitPullTables,
 * the manifest checks, then the manifest is written and staging cleared.
 * Nothing local changes unless the result is `started`. Paging is runDownload.
 */

export type StartResult =
	| { kind: 'started'; entries: ManifestEntry[] }
	/** The service answered, but the count cannot be downloaded here (§3.3 step 5). */
	| { kind: 'notDownloadable'; reason: NotDownloadableReason }
	/** No mTableInfo at all: "No Data Found." (§3.2) */
	| { kind: 'noResults'; message: string }
	| { kind: 'failed'; failure: SoapFailure };

export async function startNewDownload(
	db: LocationDb,
	client: SoapClient,
	request: { location: string; machine: string; countNumber: string; deviceInfo: string },
): Promise<StartResult> {
	const init = await client.initPullTables(request);
	if (init.kind === 'noResults') return { kind: 'noResults', message: init.message };
	if (init.kind !== 'ok') return { kind: 'failed', failure: init };

	let manifest;
	try {
		manifest = buildManifest(init.value, request.location, request.machine);
	} catch (error) {
		if (error instanceof ServiceDataError) {
			return { kind: 'failed', failure: { kind: 'unparseable', message: 'Unexpected answer from the server.', detail: error.message } };
		}
		throw error;
	}
	if (manifest.kind === 'notDownloadable') return { kind: 'notDownloadable', reason: manifest.reason };

	await db.startDownload(request.countNumber, request.location, request.machine, manifest.entries);
	return { kind: 'started', entries: manifest.entries };
}

/** Operator message for anything a download page can throw (§3.2): SOAP failures, a rejected page, a database error. */
export function describeDownloadError(error: unknown): { message: string; detail: string } {
	if (error instanceof SoapCallError) {
		const failure = error.failure;
		return { message: failure.message, detail: 'detail' in failure ? failure.detail : failure.kind === 'fault' ? failure.faultString : '' };
	}
	if (error instanceof ServiceDataError) return { message: 'Unexpected answer from the server; the page was not stored.', detail: error.message };
	return { message: 'The download stopped because of an error on this device.', detail: error instanceof Error ? error.message : String(error) };
}
