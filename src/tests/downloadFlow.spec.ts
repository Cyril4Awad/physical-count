/** Step 6: start of a download and the full flow through the SOAP client, over a fake transport serving the samples. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pageSourceFor, SoapClient, Transport } from '../soap/client';
import { formatDeviceInfo } from '../soap/envelopes';
import { runDownload } from '../storage/download';
import { describeDownloadError, startNewDownload } from '../storage/downloadFlow';
import { deleteLocationDbFile, LocationDb } from '../storage/locationDb';
import { sample } from './helpers';

const FILE = 'ERPDataCollectorNDB_FLOW';
const deviceInfo = formatDeviceInfo({ model: 'test', manufacturer: 'test', brand: 'test' });
let db: LocationDb;

/** Answers InitPullTables with `init` and pullRecords from the count 9 samples (page size 50). */
function transport(init: string | Error): { transport: Transport; calls: string[] } {
	const calls: string[] = [];
	const pages: Record<string, string> = {
		'PhysicalCountHeader@1': 'pullRecords.count9-V2-UN3.phyHeader.from1.response.xml',
		'PhysicalCountDetail@1': 'pullRecords.count9-V2-UN3.phyDetails.from1.response.xml',
		'PhysicalCountDetail@51': 'pullRecords.count9-V2-UN3.phyDetails.from51.response.xml',
		'PhysicalCountDetail@101': 'pullRecords.count9-V2-UN3.phyDetails.from101.response.xml',
	};
	return {
		calls,
		transport: async ({ soapAction, body }) => {
			const method = soapAction.replace(/.*\/(\w+)"$/, '$1');
			calls.push(method);
			if (method === 'InitPullTables') {
				if (init instanceof Error) throw init;
				return { statusCode: 200, body: sample(init) };
			}
			const table = /_tbl_(PhysicalCount\w+?)_/.exec(body)?.[1];
			const from = /<StartFromRow>(\d+)</.exec(body)?.[1];
			const name = pages[`${table}@${from}`];
			if (!name) throw new Error(`no sample for ${table}@${from}`);
			return { statusCode: 200, body: sample(name) };
		},
	};
}

async function liveCounts(): Promise<number[]> {
	return Promise.all([db.count('phyHeader'), db.count('phyDetails'), db.count('phyBarcodes')]);
}

beforeEach(async () => {
	db?.close();
	deleteLocationDbFile(FILE);
	db = LocationDb.open(FILE);
	await db.ensureSchema();
});

afterAll(() => {
	db?.close();
	deleteLocationDbFile(FILE);
});

describe('startNewDownload + runDownload through the SOAP client', () => {
	it('downloads count 9 end to end', async () => {
		const t = transport('InitPullTables.count9-V2-UN3.response.xml');
		const client = new SoapClient('10.0.2.2', t.transport);
		const started = await startNewDownload(db, client, { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo });
		expect(started.kind).toBe('started');
		expect(await runDownload(db, pageSourceFor(client), { pageSize: 50 })).toEqual({ kind: 'completed' });
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(t.calls).toEqual(['InitPullTables', 'pullRecords', 'pullRecords', 'pullRecords', 'pullRecords']);
	});

	it.each([
		['count 999999', 'InitPullTables.count999999-not-found.response.xml', 'UN3'],
		['an unassigned machine', 'InitPullTables.count9-V2-machine-not-assigned.response.xml', 'ZZ9'],
	])('%s: not downloadable, nothing local changes', async (_label, init, machine) => {
		const client = new SoapClient('10.0.2.2', transport('InitPullTables.count9-V2-UN3.response.xml').transport);
		await startNewDownload(db, client, { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo });
		await runDownload(db, pageSourceFor(client), { pageSize: 50 });
		await db.setCount('47842', 3000n);

		const t = transport(init);
		const result = await startNewDownload(db, new SoapClient('10.0.2.2', t.transport), { location: 'V2', machine, countNumber: '999999', deviceInfo });
		expect(result).toEqual({ kind: 'notDownloadable', reason: 'notFound' });
		expect(t.calls).toEqual(['InitPullTables']);
		expect(await liveCounts()).toEqual([1, 102, 0]);
		expect(await db.pendingCount()).toBe(1);
		expect(await db.isDownloadInProgress()).toBe(false);
	});

	it('server unreachable: a failure result, nothing local changes', async () => {
		const t = transport(new Error('java.net.ConnectException: Failed to connect to /10.0.2.2:80'));
		const result = await startNewDownload(db, new SoapClient('10.0.2.2', t.transport), { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo });
		expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'unreachable', message: 'Cannot reach the server at 10.0.2.2.' } });
		expect(await db.isDownloadInProgress()).toBe(false);
	});

	it('a page failure is described for the operator and leaves the download resumable', async () => {
		const good = transport('InitPullTables.count9-V2-UN3.response.xml');
		let failPages = true;
		const flaky: Transport = async (request) => {
			if (failPages && request.soapAction.includes('pullRecords') && request.body.includes('<StartFromRow>51<')) {
				throw new Error('java.net.SocketTimeoutException: timeout');
			}
			return good.transport(request);
		};
		const client = new SoapClient('10.0.2.2', flaky);
		await startNewDownload(db, client, { location: 'V2', machine: 'UN3', countNumber: '9', deviceInfo });
		let error: unknown;
		try {
			await runDownload(db, pageSourceFor(client), { pageSize: 50 });
		} catch (e) {
			error = e;
		}
		expect(describeDownloadError(error)).toEqual({ message: 'The server did not answer in 30 s.', detail: '' });
		expect((await db.pullStatus())[1].rowsStored).toBe(50);

		failPages = false;
		expect(await runDownload(db, pageSourceFor(client), { pageSize: 50 })).toEqual({ kind: 'completed' });
		expect(await liveCounts()).toEqual([1, 102, 0]);
	});
});
