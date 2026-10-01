/** Step 9: the upload loop over the real location database and the SOAP client, with a fake transport (REBUILD_PLAN §6.2). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SoapClient, Transport } from '../soap/client';
import { runDownload } from '../storage/download';
import { deleteLocationDbFile, LocationDb } from '../storage/locationDb';
import { runUpload } from '../storage/upload';
import { count9Source, manifestEntries, sample } from './helpers';

const FILE = 'ERPDataCollectorNDB_UPLOAD';
const COUNT9 = manifestEntries('InitPullTables.count9-V2-UN3.response.xml', 'V2', 'UN3');
const OK = sample('InsertDetail.count9-V2-slot4.send5.response.xml');
const answer = (text: string) => OK.replace('<InsertDetailResult>ok</InsertDetailResult>', `<InsertDetailResult>${text}</InsertDetailResult>`);

let db: LocationDb;

async function downloadCount9(): Promise<void> {
	await db.startDownload('9', 'V2', 'UN3', COUNT9);
	await runDownload(db, count9Source().fetchPage, { pageSize: 50 });
}

/** Answers each InsertDetail from a script; records `transCount:Pcd_RecId:usercounted` of every call. */
function service(reply: (call: number) => string | Error) {
	const calls: string[] = [];
	const transport: Transport = async ({ body }) => {
		const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? '';
		calls.push(`${field('transCount')}:${field('Pcd_RecId')}:${field('usercounted')}`);
		const response = reply(calls.length);
		if (response instanceof Error) throw response;
		return { statusCode: 200, body: response };
	};
	return { client: new SoapClient('10.0.2.2', transport), calls };
}

async function header() {
	const sheet = await db.sheetInfo();
	if (!sheet) throw new Error('no sheet');
	return { location: 'V2', invId: sheet.invId, userToUpdate: sheet.userToUpdate };
}

beforeEach(async () => {
	db?.close();
	deleteLocationDbFile(FILE);
	db = LocationDb.open(FILE);
	await db.ensureSchema();
	await downloadCount9();
	// Counted out of line order: the upload still goes in _id order.
	await db.setCount('47902', 31500n);
	await db.setCount('47842', 5000n);
	await db.setCount('47901', 125n);
	await db.setCount('47844', 12000n);
});

afterAll(() => {
	db?.close();
	deleteLocationDbFile(FILE);
});

describe('upload on the location database', () => {
	it('reads InvID and UserToUpdate from the downloaded header', async () => {
		expect(await header()).toEqual({ location: 'V2', invId: '9', userToUpdate: '4' });
	});

	it('sends the counted lines in _id order and marks each uploaded', async () => {
		const { client, calls } = service(() => OK);
		expect(await runUpload(db, client, await header(), { now: () => new Date('2026-10-01T08:15:00Z') })).toEqual({ kind: 'completed', total: 4, sent: 4 });
		expect(calls).toEqual(['1:47842:5.0', '2:47844:12.0', '3:47901:0.125', '4:47902:31.5']);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 98, pending: 0, uploaded: 4 });
		expect((await db.getLine('47901'))?.state).toBe('2');
		expect(await db.sheetInfo()).toMatchObject({ lastUploadAt: '2026-10-01T08:15:00.000Z', lastUploadLines: 4 });
	});

	it('a refusal at the first line leaves every line counted and records no upload', async () => {
		const { client, calls } = service(() => answer('This Physical Count Was Cancelled'));
		const outcome = await runUpload(db, client, await header());
		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 0, stop: { pcdRecId: '47842', reference: 'N/PD/SEL/1/N', title: 'This count was cancelled' } });
		expect(calls).toEqual(['1:47842:5.0']);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 98, pending: 4, uploaded: 0 });
		expect(await db.sheetInfo()).toMatchObject({ lastUploadAt: '', lastUploadLines: 0 });
	});

	it('a connection lost mid-run: lines before it are uploaded, the rest pending; the next run sends only those', async () => {
		const first = service((call) => (call === 3 ? new Error('java.net.SocketException: Software caused connection abort') : OK));
		const outcome = await runUpload(db, first.client, await header(), { now: () => new Date('2026-10-01T08:15:00Z') });
		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 2, stop: { pcdRecId: '47901', title: 'Connection lost' } });
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 98, pending: 2, uploaded: 2 });
		expect((await db.getLine('47901'))?.state).toBe('1');
		expect(await db.sheetInfo()).toMatchObject({ lastUploadLines: 2 });

		const second = service(() => OK);
		expect(await runUpload(db, second.client, await header(), { now: () => new Date('2026-10-01T08:20:00Z') })).toEqual({ kind: 'completed', total: 2, sent: 2 });
		expect(second.calls).toEqual(['1:47901:0.125', '2:47902:31.5']);
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 98, pending: 0, uploaded: 4 });
		expect(await db.sheetInfo()).toMatchObject({ lastUploadAt: '2026-10-01T08:20:00.000Z', lastUploadLines: 2 });
	});

	it('Restore uploaded sends the same lines and totals again', async () => {
		const first = service(() => OK);
		await runUpload(db, first.client, await header());
		expect(await db.restoreUploaded()).toBe(4);
		const second = service(() => OK);
		expect(await runUpload(db, second.client, await header())).toEqual({ kind: 'completed', total: 4, sent: 4 });
		expect(second.calls).toEqual(first.calls);
	});

	it('a line counted again after upload is pending again and goes with the next run', async () => {
		await runUpload(db, service(() => OK).client, await header());
		await db.setCount('47844', 13000n);
		const again = service(() => OK);
		expect(await runUpload(db, again.client, await header())).toEqual({ kind: 'completed', total: 1, sent: 1 });
		expect(again.calls).toEqual(['1:47844:13.0']);
	});

	it('pendingLinesAfter pages by _id', async () => {
		expect((await db.pendingLinesAfter(0, 2)).map((l) => l.pcdRecId)).toEqual(['47842', '47844']);
		const second = await db.pendingLinesAfter(3, 10);
		expect(second.map((l) => [l.pcdRecId, l.reference, l.counted])).toEqual([
			['47901', 'N/PD/SEL/13/N', 125n],
			['47902', 'N/PD/SEL/14/N', 31500n],
		]);
		await expect(db.pendingLinesAfter(-1, 10)).rejects.toThrow('Invalid id');
	});

	it('the last upload is stored with the sheet: a new download clears it', async () => {
		await runUpload(db, service(() => OK).client, await header(), { now: () => new Date('2026-10-01T08:15:00Z') });
		expect(await db.sheetInfo()).toMatchObject({ lastUploadLines: 4 });
		await downloadCount9();
		expect(await db.sheetInfo()).toMatchObject({ countNumber: '9', lastUploadAt: '', lastUploadLines: 0 });
		expect(await db.counters()).toEqual({ lines: 102, notCounted: 102, pending: 0, uploaded: 0 });
	});
});
