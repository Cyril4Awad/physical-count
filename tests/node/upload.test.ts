import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Milli } from '../../src/domain/decimal';
import { confirmText, lastUploadText, NO_COUNTED_ITEMS, pendingText, readInsertAnswer, rowText, sentText } from '../../src/domain/uploadText';
import { SoapClient, TransportRequest, TransportResponse } from '../../src/soap/client';
import { checkUploadHeader, runUpload, UploadLine, UploadStore } from '../../src/storage/upload';
import { sample } from './samples';

const SAMPLES_DIR = join(__dirname, '..', '..', 'docs', 'service-samples');
/** The saved answer to a real InsertDetail (`ok`), and the same envelope carrying the service's other texts. */
const OK = sample('InsertDetail.count9-V2-slot4.send5.response.xml');
const answer = (text: string) => OK.replace('<InsertDetailResult>ok</InsertDetailResult>', `<InsertDetailResult>${text}</InsertDetailResult>`);
const CANCELLED = 'This Physical Count Was Cancelled';
const POSTED = 'This Physical Count Was Already Updated To Stock';
const MISSING = 'This Physical Count Does Not Exist';
/** What Service1.asmx.vb builds on an exception: the UPDATE statement, ":", the SQL error. */
const SQL_ERROR =
	" Update tbl_PhysicalCountDetail  set Pcd_QtyCounted4 = 7.0 , Pcd_Type4 = 10, Pcd_DateCount=getdate() where Pcd_RecId=&apos;47843&apos; and Pcd_loc = &apos;V2&apos;" +
	':Arithmetic overflow error converting numeric to data type numeric. The statement has been terminated.';

const HEADER = { location: 'V2', invId: '9', userToUpdate: '4' };

interface StoredLine extends UploadLine {
	state: '0' | '1' | '2';
}

/** phyDetails in memory: the lines, their states, and what tblSheet remembers of the last upload. */
function sheet(lines: Array<[id: number, pcdRecId: string, counted: Milli | null, state?: '0' | '1' | '2']>) {
	const rows: StoredLine[] = lines.map(([id, pcdRecId, counted, state]) => ({ id, pcdRecId, reference: `REF/${pcdRecId}`, counted, state: state ?? '1' }));
	const lastUpload: Array<{ at: string; sent: number }> = [];
	const store: UploadStore = {
		pendingCount: async () => rows.filter((r) => r.state === '1').length,
		pendingLinesAfter: async (afterId, limit) =>
			rows
				.filter((r) => r.state === '1' && r.id > afterId)
				.sort((a, b) => a.id - b.id)
				.slice(0, limit),
		markUploaded: async (pcdRecId) => {
			const row = rows.find((r) => r.pcdRecId === pcdRecId && r.state === '1');
			if (row) row.state = '2';
		},
		recordUpload: async (at, sent) => {
			lastUpload.push({ at, sent });
		},
	};
	const states = () => Object.fromEntries(rows.map((r) => [r.pcdRecId, r.state]));
	return { store, states, lastUpload };
}

/** A service that answers each InsertDetail from a script and records what it was sent. */
function service(reply: (sent: Record<string, string>, call: number) => string | Error) {
	const calls: Array<Record<string, string>> = [];
	const transport = async (request: TransportRequest): Promise<TransportResponse> => {
		const sent: Record<string, string> = {};
		for (const [, name, value] of request.body.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) sent[name] = value;
		calls.push(sent);
		const body = reply(sent, calls.length);
		if (body instanceof Error) throw body;
		return { statusCode: 200, body };
	};
	return { client: new SoapClient('10.0.2.2', transport), calls };
}

const FOUR = () =>
	sheet([
		[3, '47844', 2750n],
		[1, '47842', 5000n],
		[7, '47848', 12000n],
		[2, '47843', 125n],
		[5, '47846', 9000n, '0'],
		[6, '47847', 4000n, '2'],
	]);

describe('a full upload', () => {
	it('sends every counted line once, in _id order, transCount 1, 2, 3…, and marks each uploaded', async () => {
		const { store, states, lastUpload } = FOUR();
		const { client, calls } = service(() => OK);
		const progress: string[] = [];
		const outcome = await runUpload(store, client, HEADER, { onProgress: (p) => progress.push(`${p.row}/${p.total}:${p.pcdRecId}`), now: () => new Date('2026-10-01T08:15:00Z') });

		expect(outcome).toEqual({ kind: 'completed', total: 4, sent: 4 });
		expect(calls).toEqual([
			{ transCount: '1', SelectedLocation: 'V2', uInvID: '9', id: '1', Pcd_RecId: '47842', usercounted: '5.0', uUserToUpdate: '4' },
			{ transCount: '2', SelectedLocation: 'V2', uInvID: '9', id: '2', Pcd_RecId: '47843', usercounted: '0.125', uUserToUpdate: '4' },
			{ transCount: '3', SelectedLocation: 'V2', uInvID: '9', id: '3', Pcd_RecId: '47844', usercounted: '2.75', uUserToUpdate: '4' },
			{ transCount: '4', SelectedLocation: 'V2', uInvID: '9', id: '7', Pcd_RecId: '47848', usercounted: '12.0', uUserToUpdate: '4' },
		]);
		expect(progress).toEqual(['1/4:47842', '2/4:47843', '3/4:47844', '4/4:47848']);
		// Not-counted and already-uploaded lines are left alone.
		expect(states()).toEqual({ '47842': '2', '47843': '2', '47844': '2', '47848': '2', '47846': '0', '47847': '2' });
		expect(lastUpload).toEqual([{ at: '2026-10-01T08:15:00.000Z', sent: 4 }]);
	});

	it('the first request is byte for byte the saved InsertDetail request', async () => {
		const bodies: string[] = [];
		const client = new SoapClient('10.0.2.2', async (request) => {
			bodies.push(request.body);
			return { statusCode: 200, body: OK };
		});
		await runUpload(sheet([[1, '47842', 5000n]]).store, client, HEADER);
		expect(Buffer.from(bodies[0], 'utf8')).toEqual(readFileSync(join(SAMPLES_DIR, 'InsertDetail.count9-V2-slot4.send5.request.xml')));
	});

	it('with nothing counted, calls nothing and records nothing', async () => {
		const { store, lastUpload } = sheet([[1, '47842', 0n, '0']]);
		const { client, calls } = service(() => OK);
		expect(await runUpload(store, client, HEADER)).toEqual({ kind: 'completed', total: 0, sent: 0 });
		expect(calls).toEqual([]);
		expect(lastUpload).toEqual([]);
	});

	it('pages through more lines than one batch', async () => {
		const many = Array.from({ length: 450 }, (_, i): [number, string, Milli] => [i + 1, String(50000 + i), 1000n]);
		const { store, states } = sheet(many);
		const { client, calls } = service(() => OK);
		expect(await runUpload(store, client, HEADER)).toEqual({ kind: 'completed', total: 450, sent: 450 });
		expect(calls.map((c) => c.transCount)).toEqual(Array.from({ length: 450 }, (_, i) => String(i + 1)));
		expect(Object.values(states()).every((s) => s === '2')).toBe(true);
	});
});

describe('the three refusals at the first line', () => {
	it.each([
		[CANCELLED, 'This count was cancelled', 'cancelled in the ERP'],
		[POSTED, 'This count is already posted', 'already updated to stock'],
		[MISSING, 'This count does not exist on the server', 'no physical count with this number'],
	])('"%s": stops at once, nothing is marked, the counts stay', async (text, title, words) => {
		const { store, states, lastUpload } = FOUR();
		const { client, calls } = service(() => answer(text));
		const outcome = await runUpload(store, client, HEADER);

		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 0, stop: { pcdRecId: '47842', reference: 'REF/47842', title, detail: '' } });
		expect(outcome.stop?.message).toContain(words);
		expect(outcome.stop?.message).toContain('Nothing was sent. Your counts are still on this device.');
		expect(calls).toHaveLength(1);
		expect(calls[0].transCount).toBe('1');
		expect(states()).toMatchObject({ '47842': '1', '47843': '1', '47844': '1', '47848': '1' });
		// A run that sent nothing is not a "last upload".
		expect(lastUpload).toEqual([]);
	});
});

describe('a line the server did not save', () => {
	it('SQL error: shows only the part after the first ":", keeps the full text for the log, stops there', async () => {
		const { store, states, lastUpload } = FOUR();
		const { client, calls } = service((_sent, call) => (call === 2 ? answer(SQL_ERROR) : OK));
		const logged: string[] = [];
		const outcome = await runUpload(store, client, HEADER, { log: (m) => logged.push(m) });

		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 1 });
		expect(outcome.stop).toEqual({
			pcdRecId: '47843',
			reference: 'REF/47843',
			title: 'The server could not save this line',
			message: 'Arithmetic overflow error converting numeric to data type numeric. The statement has been terminated. Your counts are still on this device.',
			detail: '',
		});
		expect(outcome.stop?.message).not.toContain('Update tbl_PhysicalCountDetail');
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("Update tbl_PhysicalCountDetail  set Pcd_QtyCounted4 = 7.0 , Pcd_Type4 = 10, Pcd_DateCount=getdate() where Pcd_RecId='47843' and Pcd_loc = 'V2':Arithmetic overflow");
		expect(calls).toHaveLength(2);
		expect(states()).toMatchObject({ '47842': '2', '47843': '1', '47844': '1', '47848': '1' });
		expect(lastUpload).toHaveLength(1);
		expect(lastUpload[0].sent).toBe(1);
	});

	it.each([['OK'], ['ok.'], ['done'], ['']])('any answer that is not exactly "ok" stops the run: "%s"', async (text) => {
		const { store, states } = FOUR();
		const { client, calls } = service((_sent, call) => (call === 3 ? answer(text) : OK));
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome).toMatchObject({ kind: 'stopped', sent: 2, stop: { pcdRecId: '47844', title: 'Unexpected answer from the server' } });
		expect(outcome.stop?.message).toBe(`The server answered "${text}" instead of "ok", so the upload stopped. Your counts are still on this device.`);
		expect(calls).toHaveLength(3);
		expect(states()).toMatchObject({ '47842': '2', '47843': '2', '47844': '1', '47848': '1' });
	});

	it('timeout: the line stays counted, and the message says it may be saved and that resending is safe', async () => {
		const { store, states } = FOUR();
		const { client, calls } = service((_sent, call) => (call === 3 ? new Error('java.net.SocketTimeoutException: timeout') : OK));
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 2 });
		expect(outcome.stop).toEqual({
			pcdRecId: '47844',
			reference: 'REF/47844',
			title: 'The server did not answer',
			message:
				'The server did not answer in 30 s. Line 47844 may already have been saved on the server. It is still marked as not uploaded here, and sending it again is safe. Your counts are still on this device.',
			detail: '',
		});
		expect(calls).toHaveLength(3);
		expect(states()).toMatchObject({ '47842': '2', '47843': '2', '47844': '1', '47848': '1' });
	});

	it('lost connection: same, with the technical text as a detail', async () => {
		const { store, states } = FOUR();
		const { client } = service((_sent, call) => (call === 2 ? new Error('java.net.ConnectException: Failed to connect to /10.0.2.2:80') : OK));
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome.stop).toEqual({
			pcdRecId: '47843',
			reference: 'REF/47843',
			title: 'Connection lost',
			message:
				'Cannot reach the server at 10.0.2.2. Line 47843 may already have been saved on the server. It is still marked as not uploaded here, and sending it again is safe. Your counts are still on this device.',
			detail: 'java.net.ConnectException: Failed to connect to /10.0.2.2:80',
		});
		expect(states()).toMatchObject({ '47842': '2', '47843': '1' });
	});

	it('an answer that is not the expected XML stops the run too', async () => {
		const { store, states } = FOUR();
		const { client } = service(() => '<html>proxy error</html>');
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome).toMatchObject({ kind: 'stopped', sent: 0, stop: { pcdRecId: '47842', title: 'Unexpected answer from the server' } });
		expect(states()['47842']).toBe('1');
	});
});

describe('the next run', () => {
	it('sends only the lines still pending, and starts transCount at 1 again', async () => {
		const { store, states, lastUpload } = FOUR();
		const first = service((_sent, call) => (call === 3 ? new Error('java.net.SocketTimeoutException: timeout') : OK));
		await runUpload(store, first.client, HEADER);

		const second = service(() => OK);
		expect(await runUpload(store, second.client, HEADER)).toEqual({ kind: 'completed', total: 2, sent: 2 });
		expect(second.calls.map((c) => [c.transCount, c.Pcd_RecId])).toEqual([
			['1', '47844'],
			['2', '47848'],
		]);
		expect(states()).toMatchObject({ '47842': '2', '47843': '2', '47844': '2', '47848': '2' });
		expect(lastUpload.map((u) => u.sent)).toEqual([2, 2]);
	});
});

describe('Cancel', () => {
	it('takes effect between lines: the line being sent finishes, the rest stay counted', async () => {
		const { store, states, lastUpload } = FOUR();
		let cancel = false;
		const { client, calls } = service((_sent, call) => {
			if (call === 2) cancel = true; // tapped while line 2 is on its way
			return OK;
		});
		expect(await runUpload(store, client, HEADER, { shouldCancel: () => cancel })).toEqual({ kind: 'cancelled', total: 4, sent: 2 });
		expect(calls).toHaveLength(2);
		expect(states()).toMatchObject({ '47842': '2', '47843': '2', '47844': '1', '47848': '1' });
		expect(lastUpload.map((u) => u.sent)).toEqual([2]);
	});

	it('before the first line: nothing is sent', async () => {
		const { store, lastUpload } = FOUR();
		const { client, calls } = service(() => OK);
		expect(await runUpload(store, client, HEADER, { shouldCancel: () => true })).toEqual({ kind: 'cancelled', total: 4, sent: 0 });
		expect(calls).toEqual([]);
		expect(lastUpload).toEqual([]);
	});
});

describe('checks before any call (§3.7)', () => {
	it.each([
		[{ ...HEADER, invId: '' }, 'the count number in the downloaded header ("") is not valid.'],
		[{ ...HEADER, invId: "9' OR '1'='1" }, `the count number in the downloaded header ("9' OR '1'='1") is not valid.`],
		[{ ...HEADER, userToUpdate: '7' }, 'the machine slot in the downloaded header ("7") is not 1 to 6.'],
		[{ ...HEADER, userToUpdate: '' }, 'the machine slot in the downloaded header ("") is not 1 to 6.'],
		[{ ...HEADER, location: 'V2;' }, 'the location code "V2;" is not valid.'],
	])('an invalid header value stops the run before the service is called: %j', async (header, problem) => {
		const { store, states } = FOUR();
		const { client, calls } = service(() => OK);
		expect(checkUploadHeader(header)).toBe(problem);
		const outcome = await runUpload(store, client, header);
		expect(outcome).toMatchObject({ kind: 'stopped', total: 4, sent: 0, stop: { pcdRecId: null, title: 'This count cannot be uploaded' } });
		expect(outcome.stop?.message).toBe(`The count on this device cannot be uploaded: ${problem} Nothing was sent. Download the count again. Your counts are still on this device.`);
		expect(calls).toEqual([]);
		expect(states()['47842']).toBe('1');
	});

	it('accepts a valid header', () => {
		expect(checkUploadHeader(HEADER)).toBeNull();
	});

	it.each([
		['a negative total', -1000n, 'The quantity cannot be negative.'],
		['a total above the server limit', 100_000_000_000_000_000n, 'The quantity is too large.'],
		['a total that cannot be read', null, 'its stored total cannot be read.'],
	])('%s is not sent; the run stops at that line', async (_label, counted, problem) => {
		const { store, states } = sheet([
			[1, '47842', 5000n],
			[2, '47843', counted],
			[3, '47844', 1000n],
		]);
		const { client, calls } = service(() => OK);
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome).toMatchObject({ kind: 'stopped', sent: 1, stop: { pcdRecId: '47843', title: 'This line cannot be sent' } });
		expect(outcome.stop?.message).toBe(`Line 47843 cannot be sent: ${problem} Correct its total in Scan, then upload again. Your counts are still on this device.`);
		expect(calls).toHaveLength(1);
		expect(states()).toEqual({ '47842': '2', '47843': '1', '47844': '1' });
	});

	it('a line id that is not digits is never put into a request', async () => {
		const { store } = sheet([[1, "47842' OR 1=1 --", 5000n]]);
		const { client, calls } = service(() => OK);
		const outcome = await runUpload(store, client, HEADER);
		expect(outcome).toMatchObject({ kind: 'stopped', sent: 0, stop: { title: 'This line cannot be sent' } });
		expect(calls).toEqual([]);
	});
});

describe('reading the service answer', () => {
	it('only exactly "ok" is ok', () => {
		expect(readInsertAnswer('ok')).toEqual({ kind: 'ok' });
		for (const text of ['OK', 'Ok', 'ok ', ' ok', 'ok\n', 'okay', '']) expect(readInsertAnswer(text).kind).toBe('unexpected');
	});

	it('knows the three refusals', () => {
		expect(readInsertAnswer(CANCELLED)).toEqual({
			kind: 'refused',
			title: 'This count was cancelled',
			message: 'The server refused the upload: this physical count was cancelled in the ERP. Nothing was sent. Your counts are still on this device.',
		});
		expect(readInsertAnswer(POSTED)).toEqual({
			kind: 'refused',
			title: 'This count is already posted',
			message:
				'The server refused the upload: this physical count was already updated to stock in the ERP, so it no longer accepts counts. Nothing was sent. Your counts are still on this device.',
		});
		expect(readInsertAnswer(MISSING)).toEqual({
			kind: 'refused',
			title: 'This count does not exist on the server',
			message: 'The server refused the upload: it has no physical count with this number. Nothing was sent. Your counts are still on this device.',
		});
	});

	it('shortens an UPDATE error to the SQL error', () => {
		const text = " Update tbl_PhysicalCountDetail  set Pcd_QtyCounted4 = 7.0 , Pcd_Type4 = 10, Pcd_DateCount=getdate() where Pcd_RecId='47843' and Pcd_loc = 'V2':Timeout expired: the server is busy.";
		expect(readInsertAnswer(text)).toMatchObject({ kind: 'sqlError', message: 'Timeout expired: the server is busy. Your counts are still on this device.' });
		expect(readInsertAnswer('Update tbl_PhysicalCountDetail set x = 1:')).toMatchObject({
			kind: 'sqlError',
			message: 'The database reported an error without a message. Your counts are still on this device.',
		});
	});

	it('cuts a very long unexpected answer', () => {
		const answerText = readInsertAnswer('x'.repeat(5000));
		expect(answerText.kind).toBe('unexpected');
		expect(answerText.kind !== 'ok' && answerText.message.length).toBeLessThan(420);
	});
});

describe('Upload screen texts', () => {
	it('confirmation, progress and result lines', () => {
		expect(confirmText(7)).toBe('This Physical Count Contains 7 Items. Upload?');
		expect(NO_COUNTED_ITEMS).toBe('No Counted Items Found.');
		expect(rowText(3, 7)).toBe('Row 3 / 7');
		expect(sentText(0)).toBe('No lines were sent.');
		expect(sentText(1)).toBe('1 line sent.');
		expect(sentText(7)).toBe('7 lines sent.');
		expect(pendingText(0)).toBe('No lines are waiting for upload.');
		expect(pendingText(1)).toBe('1 line still waiting for upload.');
		expect(pendingText(4)).toBe('4 lines still waiting for upload.');
	});

	it("Home's Last upload line: local date and time and the lines sent in that run", () => {
		const at = new Date(2026, 9, 1, 8, 5).toISOString();
		expect(lastUploadText(at, 7)).toBe('01/10/2026 08:05 · 7 lines');
		expect(lastUploadText(at, 1)).toBe('01/10/2026 08:05 · 1 line');
		expect(lastUploadText('', 0)).toBeNull();
		expect(lastUploadText('', 3)).toBeNull();
		expect(lastUploadText(at, 0)).toBeNull();
		expect(lastUploadText('not a date', 3)).toBeNull();
	});
});
