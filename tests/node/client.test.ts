import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../src/domain/check';
import { pageSourceFor, SoapCallError, SoapClient, Transport, TransportRequest, TransportResponse } from '../../src/soap/client';
import { formatDeviceInfo } from '../../src/soap/envelopes';
import { envelope, sample } from './samples';

const SAMPLES_DIR = join(__dirname, '..', '..', 'docs', 'service-samples');
const deviceInfo = formatDeviceInfo({ model: 'rebuild-test', manufacturer: 'local', brand: 'local' });
const INIT_9 = { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo };
const PAGE = { tableName: '_ERPDATACOLLECTOR_tbl_PhysicalCountDetail_V2UN3', pageSize: 50, startFromRow: 1 };
const INSERT = { transCount: 1, location: 'V2', invId: '9', localId: 1, pcdRecId: '47842', counted: 5000n, userToUpdate: '4' };

/** A transport that records requests and answers from a script. */
function fakeTransport(answer: (request: TransportRequest) => Promise<TransportResponse> | TransportResponse) {
	const requests: TransportRequest[] = [];
	const transport: Transport = async (request) => {
		requests.push(request);
		return answer(request);
	};
	return { transport, requests };
}

const ok = (body: string): TransportResponse => ({ statusCode: 200, body });
const FAULT = envelope(
	'<soap:Fault><faultcode>soap:Client</faultcode><faultstring>System.Web.Services.Protocols.SoapException: Server was unable to read request.</faultstring></soap:Fault>',
);

afterEach(() => {
	vi.useRealTimers();
});

describe('requests', () => {
	it('posts the exact InitPullTables envelope with the quoted SOAPAction and a 120 s timeout', async () => {
		const { transport, requests } = fakeTransport(() => ok(sample('InitPullTables.count9-V2-UN3.response.xml')));
		await new SoapClient('10.0.2.2', transport).initPullTables(INIT_9);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe('http://10.0.2.2/ERPDataCollector/Service1.asmx');
		expect(requests[0].soapAction).toBe('"http://tempuri.org/InitPullTables"');
		expect(Buffer.from(requests[0].body, 'utf8')).toEqual(readFileSync(join(SAMPLES_DIR, 'InitPullTables.count9-V2-UN3.request.xml')));
		expect(requests[0].timeoutMs).toBe(120_000);
	});

	it('uses 30 s for pullRecords and InsertDetail', async () => {
		const { transport, requests } = fakeTransport((r) =>
			ok(r.soapAction.includes('pullRecords') ? sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml') : sample('InsertDetail.count9-V2-slot4.send5.response.xml')),
		);
		const client = new SoapClient('erp-v2:8080', transport);
		await client.pullRecords(PAGE);
		await client.insertDetail(INSERT);
		expect(requests.map((r) => [r.soapAction, r.timeoutMs])).toEqual([
			['"http://tempuri.org/pullRecords"', 30_000],
			['"http://tempuri.org/InsertDetail"', 30_000],
		]);
		expect(requests[0].url).toBe('http://erp-v2:8080/ERPDataCollector/Service1.asmx');
		expect(Buffer.from(requests[0].body)).toEqual(readFileSync(join(SAMPLES_DIR, 'pullRecords.count9-V2-UN3.phyDetails.from1.request.xml')));
	});

	it('refuses an invalid server address when the client is created', () => {
		expect(() => new SoapClient('http://10.0.2.2', fakeTransport(() => ok('')).transport)).toThrow(InvalidInputError);
	});

	it('does not send anything when a value fails the §3.7 checks', async () => {
		const { transport, requests } = fakeTransport(() => ok(''));
		const result = await new SoapClient('10.0.2.2', transport).initPullTables({ ...INIT_9, machine: "UN3' OR '1'='1" });
		expect(result).toEqual({ kind: 'invalidInput', message: 'The machine name is 1 to 5 letters or digits.' });
		expect(requests).toHaveLength(0);
	});
});

describe('outcomes (§3.2)', () => {
	it('ok: the tables of InitPullTables', async () => {
		const result = await new SoapClient('10.0.2.2', fakeTransport(() => ok(sample('InitPullTables.count9-V2-UN3.response.xml'))).transport).initPullTables(INIT_9);
		expect(result.kind).toBe('ok');
		expect(result.kind === 'ok' && result.value.map((t) => t.RowsCount)).toEqual(['1', '102', '0']);
	});

	it('ok: the rows of a page', async () => {
		const result = await new SoapClient('10.0.2.2', fakeTransport(() => ok(sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'))).transport).pullRecords(PAGE);
		expect(result.kind === 'ok' && result.value).toHaveLength(50);
	});

	it('noResults: InitPullTables without mTableInfo → "No Data Found."', async () => {
		const xml = envelope('<InitPullTablesResponse xmlns="http://tempuri.org/"><InitPullTablesResult /></InitPullTablesResponse>');
		expect(await new SoapClient('10.0.2.2', fakeTransport(() => ok(xml)).transport).initPullTables(INIT_9)).toEqual({ kind: 'noResults', message: 'No Data Found.' });
	});

	it('noResults: a page past the end', async () => {
		const client = new SoapClient('10.0.2.2', fakeTransport(() => ok(sample('pullRecords.count9-V2-UN3.phyDetails.from103-past-end.response.xml'))).transport);
		expect(await client.pullRecords({ ...PAGE, startFromRow: 103 })).toMatchObject({ kind: 'noResults' });
	});

	it('fault: SOAP Fault with HTTP 500', async () => {
		const client = new SoapClient('10.0.2.2', fakeTransport(() => ({ statusCode: 500, body: FAULT })).transport);
		expect(await client.pullRecords(PAGE)).toEqual({
			kind: 'fault',
			message: 'Service fault: System.Web.Services.Protocols.SoapException: Server was unable to read request.',
			faultString: 'System.Web.Services.Protocols.SoapException: Server was unable to read request.',
		});
	});

	it.each([
		[404, '<html><body>404 - File or directory not found.</body></html>'],
		[500, '<!DOCTYPE html><html><body>Server Error in /ERPDataCollector Application.</body></html>'],
		[503, 'Service Unavailable'],
	])('unreachable: HTTP %i with a non-SOAP body', async (statusCode, body) => {
		const result = await new SoapClient('10.0.2.2', fakeTransport(() => ({ statusCode, body })).transport).pullRecords(PAGE);
		expect(result).toEqual({
			kind: 'unreachable',
			message: 'Cannot reach the server at 10.0.2.2.',
			detail: `HTTP ${statusCode} from http://10.0.2.2/ERPDataCollector/Service1.asmx`,
		});
	});

	it.each([
		'java.net.ConnectException: Failed to connect to /10.0.2.2:80',
		'java.net.UnknownHostException: Unable to resolve host "erp-v2": No address associated with hostname',
		'java.net.UnknownServiceException: CLEARTEXT communication to erp-v2 not permitted by network security policy',
	])('unreachable: %s', async (text) => {
		const result = await new SoapClient('erp-v2', fakeTransport(() => Promise.reject(new Error(text))).transport).pullRecords(PAGE);
		expect(result).toEqual({ kind: 'unreachable', message: 'Cannot reach the server at erp-v2.', detail: text });
	});

	it('timeout: the transport reports a socket timeout', async () => {
		const client = new SoapClient('10.0.2.2', fakeTransport(() => Promise.reject(new Error('java.net.SocketTimeoutException: timeout'))).transport);
		expect(await client.pullRecords(PAGE)).toEqual({ kind: 'timeout', message: 'The server did not answer in 30 s.', timeoutMs: 30_000 });
		expect(await client.initPullTables(INIT_9)).toMatchObject({ kind: 'timeout', message: 'The server did not answer in 120 s.' });
	});

	it('timeout: the transport never answers (JS guard)', async () => {
		vi.useFakeTimers();
		const client = new SoapClient('10.0.2.2', fakeTransport(() => new Promise<TransportResponse>(() => undefined)).transport);
		const pending = client.pullRecords(PAGE);
		await vi.advanceTimersByTimeAsync(35_001);
		expect(await pending).toMatchObject({ kind: 'timeout', timeoutMs: 30_000 });
	});

	it.each([
		['plain text with HTTP 200', 'OK'],
		['a truncated page', sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml').slice(0, 3000)],
		['another method’s answer', sample('InsertDetail.count9-V2-slot4.send5.response.xml')],
	])('unparseable: %s', async (_label, body) => {
		const result = await new SoapClient('10.0.2.2', fakeTransport(() => ok(body)).transport).pullRecords(PAGE);
		expect(result).toMatchObject({ kind: 'unparseable', message: 'Unexpected answer from the server.' });
	});

	it('InsertDetail returns the service text as is (not called against the server before step 9)', async () => {
		const cancelled = envelope('<InsertDetailResponse xmlns="http://tempuri.org/"><InsertDetailResult>This Physical Count Was Cancelled</InsertDetailResult></InsertDetailResponse>');
		expect(await new SoapClient('10.0.2.2', fakeTransport(() => ok(sample('InsertDetail.count9-V2-slot4.send5.response.xml'))).transport).insertDetail(INSERT)).toEqual({ kind: 'ok', value: 'ok' });
		expect(await new SoapClient('10.0.2.2', fakeTransport(() => ok(cancelled)).transport).insertDetail(INSERT)).toEqual({ kind: 'ok', value: 'This Physical Count Was Cancelled' });
	});
});

describe('page source for the download loop', () => {
	it('passes rows and empty pages through, and throws SoapCallError on a failure', async () => {
		let answer: () => Promise<TransportResponse> = async () => ok(sample('pullRecords.count9-V2-UN3.phyDetails.from1.response.xml'));
		const fetchPage = pageSourceFor(new SoapClient('10.0.2.2', async () => answer()));

		expect((await fetchPage(PAGE)).kind).toBe('records');
		answer = async () => ok(sample('pullRecords.count9-V2-UN3.phyBarcodes.empty.response.xml'));
		expect(await fetchPage(PAGE)).toEqual({ kind: 'noResults' });
		answer = () => Promise.reject(new Error('java.net.ConnectException: Failed to connect'));
		await expect(fetchPage(PAGE)).rejects.toThrow(SoapCallError);
		await expect(fetchPage(PAGE)).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
	});
});
