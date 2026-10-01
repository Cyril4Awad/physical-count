import { SOAP_TIMEOUT_MS } from '../config';
import { InvalidInputError } from '../domain/check';
import type { Milli } from '../domain/decimal';
import { ServiceDataError } from '../parse/errors';
import { buildInitPullTables, buildInsertDetail, buildPullRecords, serviceUrl, soapAction, SoapMethod } from './envelopes';
import type { FetchPage } from '../storage/download';
import { readInitPullTables, readInsertDetail, readPullRecords, SoapFaultError, TableInfo } from './responses';

/**
 * SOAP client for Service1.asmx (REBUILD_PLAN §3.1–§3.4). Every outcome of
 * §3.2 comes back as a typed result with a message for the operator; nothing
 * throws except programming errors. The HTTP transport is injected, so this
 * module is pure and runs in Node tests; `httpTransport.ts` is the device one.
 */

export interface TransportRequest {
	url: string;
	/** SOAPAction header value, already quoted. */
	soapAction: string;
	body: string;
	timeoutMs: number;
}

export interface TransportResponse {
	statusCode: number;
	body: string;
}

/** Sends one request. Resolves with any HTTP status; rejects only when no answer arrived. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type SoapFailure =
	/** The request was not built: a value failed the §3.7 checks. */
	| { kind: 'invalidInput'; message: string }
	/** SOAP Fault (malformed request, S12). */
	| { kind: 'fault'; message: string; faultString: string }
	/** Connection refused, DNS failure, cleartext blocked, or an HTTP error status. */
	| { kind: 'unreachable'; message: string; detail: string }
	| { kind: 'timeout'; message: string; timeoutMs: number }
	/** HTTP 200, but not the expected XML (§3.5.3). The whole answer is rejected. */
	| { kind: 'unparseable'; message: string; detail: string };

export type SoapResult<T> =
	| { kind: 'ok'; value: T }
	/** The service found nothing (§3.2): `mTableInfo` or `mRecords` missing. */
	| { kind: 'noResults'; message: string }
	| SoapFailure;

/** A failed call where the caller needs an exception (the download loop, §6.1). */
export class SoapCallError extends Error {
	constructor(readonly failure: SoapFailure) {
		super(failure.message);
		this.name = 'SoapCallError';
	}
}

const TIMEOUT_TEXT = /timeout|timed out/i;
/** Extra time the JS guard gives the transport's own timeout before giving up on it. */
const GUARD_MARGIN_MS = 5_000;

function withGuard<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs + GUARD_MARGIN_MS);
	});
	return Promise.race([promise, guard]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export class SoapClient {
	private readonly url: string;

	/** `serverAddress` is the profile's host[:port]; an invalid one throws InvalidInputError (§3.7). */
	constructor(
		private readonly serverAddress: string,
		private readonly transport: Transport,
		private readonly timeouts: Record<SoapMethod, number> = SOAP_TIMEOUT_MS,
	) {
		this.url = serviceUrl(serverAddress);
	}

	private async call<T>(method: SoapMethod, build: () => string, read: (xml: string) => SoapResult<T>): Promise<SoapResult<T>> {
		let body: string;
		try {
			body = build();
		} catch (error) {
			if (error instanceof InvalidInputError) return { kind: 'invalidInput', message: error.message };
			throw error;
		}

		const timeoutMs = this.timeouts[method];
		let response: TransportResponse;
		try {
			response = await withGuard(this.transport({ url: this.url, soapAction: `"${soapAction(method)}"`, body, timeoutMs }), timeoutMs);
		} catch (error) {
			const detail = describeError(error);
			if (TIMEOUT_TEXT.test(detail)) {
				return { kind: 'timeout', message: `The server did not answer in ${Math.round(timeoutMs / 1000)} s.`, timeoutMs };
			}
			return { kind: 'unreachable', message: `Cannot reach the server at ${this.serverAddress}.`, detail };
		}

		// ASMX sends a Fault with HTTP 500, so the body is read before the status is judged.
		try {
			return read(response.body);
		} catch (error) {
			if (error instanceof SoapFaultError) return { kind: 'fault', message: error.message, faultString: error.faultString };
			if (response.statusCode < 200 || response.statusCode > 299) {
				return {
					kind: 'unreachable',
					message: `Cannot reach the server at ${this.serverAddress}.`,
					detail: `HTTP ${response.statusCode} from ${this.url}`,
				};
			}
			if (error instanceof ServiceDataError) return { kind: 'unparseable', message: 'Unexpected answer from the server.', detail: error.message };
			throw error;
		}
	}

	initPullTables(request: { location: string; machine: string; countNumber: string; deviceInfo: string }): Promise<SoapResult<TableInfo[]>> {
		return this.call(
			'InitPullTables',
			() => buildInitPullTables(request),
			(xml) => {
				const result = readInitPullTables(xml);
				return result.kind === 'tables' ? { kind: 'ok', value: result.tables } : { kind: 'noResults', message: 'No Data Found.' };
			},
		);
	}

	/** One page; `noResults` means the page is empty (past the end, an empty table, or a swallowed server error, S12). */
	pullRecords(request: { tableName: string; pageSize: number; startFromRow: number }): Promise<SoapResult<string[]>> {
		return this.call(
			'pullRecords',
			() => buildPullRecords(request),
			(xml) => {
				const result = readPullRecords(xml);
				return result.kind === 'records' ? { kind: 'ok', value: result.valuesQueries } : { kind: 'noResults', message: 'No rows returned.' };
			},
		);
	}

	/** Returns the service's text as is: exactly "ok" means the line was written (§6.2). Not called before step 9. */
	insertDetail(request: {
		transCount: number;
		location: string;
		invId: string;
		localId: number;
		pcdRecId: string;
		counted: Milli;
		userToUpdate: string;
	}): Promise<SoapResult<string>> {
		return this.call(
			'InsertDetail',
			() => buildInsertDetail(request),
			(xml) => ({ kind: 'ok', value: readInsertDetail(xml) }),
		);
	}
}

/**
 * The download loop's page source over this client (§6.1): rows or an empty
 * page on `noResults`; any failure throws SoapCallError, which leaves the
 * download resumable with Continue download.
 */
export function pageSourceFor(client: SoapClient): FetchPage {
	return async (request) => {
		const result = await client.pullRecords(request);
		if (result.kind === 'ok') return { kind: 'records', valuesQueries: result.value };
		if (result.kind === 'noResults') return { kind: 'noResults' };
		throw new SoapCallError(result);
	};
}
