import { checkUploadQuantity, Milli } from '../domain/decimal';
import { invalidHeaderText, invalidLineText, maybeSavedNote, readInsertAnswer } from '../domain/uploadText';
import { checkCountNumber, checkLocationCode, checkPcdRecId, checkUserToUpdate } from '../domain/validation';
import type { SoapResult } from '../soap/client';

/**
 * The upload loop (REBUILD_PLAN §6.2): one InsertDetail per counted line, in `_id`
 * order, `transCount` 1, 2, 3… from 1 on every run. A line becomes uploaded only
 * when the answer is exactly `ok`; anything else stops the run and leaves that
 * line and the rest pending. The store and the sender are injected (LocationDb
 * and SoapClient on the device), so the loop runs in Node tests.
 */

export interface UploadLine {
	/** `_id`: the send order, and InsertDetail's `id` (ignored by the service, S5). */
	id: number;
	pcdRecId: string;
	reference: string;
	/** `usercounted`; null when the stored text is not a readable quantity. */
	counted: Milli | null;
}

export interface UploadStore {
	/** Lines in state `'1'`. */
	pendingCount(): Promise<number>;
	/** Lines in state `'1'` with `_id` above `afterId`, in `_id` order, at most `limit`. */
	pendingLinesAfter(afterId: number, limit: number): Promise<UploadLine[]>;
	/** State `'1'` → `'2'` for one line. */
	markUploaded(pcdRecId: string): Promise<void>;
	/** Home's "Last upload": when the run ended and how many lines it sent. */
	recordUpload(at: string, sent: number): Promise<void>;
}

export interface UploadSender {
	insertDetail(request: {
		transCount: number;
		location: string;
		invId: string;
		localId: number;
		pcdRecId: string;
		counted: Milli;
		userToUpdate: string;
	}): Promise<SoapResult<string>>;
}

/** Sent with every line: the profile's location code and the sheet header's `InvID` and `UserToUpdate`. */
export interface UploadHeader {
	location: string;
	invId: string;
	userToUpdate: string;
}

export interface UploadProgress {
	/** 1-based: the line being sent, which is also its `transCount`. */
	row: number;
	total: number;
	pcdRecId: string;
}

/** Why a run stopped before the end. `pcdRecId` is null when the stop was before any line (header check). */
export interface UploadStop {
	pcdRecId: string | null;
	reference: string;
	title: string;
	message: string;
	/** Technical text (the transport's error); empty when there is none. */
	detail: string;
}

export interface UploadOutcome {
	kind: 'completed' | 'cancelled' | 'stopped';
	/** Lines in state `'1'` when the run started. */
	total: number;
	/** Lines the service answered `ok` for in this run; each is now in state `'2'`. */
	sent: number;
	stop?: UploadStop;
}

export interface UploadOptions {
	/** Checked before every line (§6.2 Cancel). */
	shouldCancel?: () => boolean;
	onProgress?: (progress: UploadProgress) => void;
	/** The full service text of a non-`ok` answer goes here (the app log), not on screen. */
	log?: (message: string) => void;
	now?: () => Date;
	/** Debug builds only: a pause before each line, so a network loss mid-run can be tested by hand. */
	delayBeforeLineMs?: number;
}

const BATCH = 200;

function stopFor(line: UploadLine, title: string, message: string, detail = ''): UploadStop {
	return { pcdRecId: line.pcdRecId, reference: line.reference, title, message, detail };
}

/** The §3.7 checks on the header values, before any call. Returns the problem, or null. */
export function checkUploadHeader(header: UploadHeader): string | null {
	if (!checkLocationCode(header.location).ok) return `the location code "${header.location}" is not valid.`;
	if (!checkCountNumber(header.invId).ok) return `the count number in the downloaded header ("${header.invId}") is not valid.`;
	if (!checkUserToUpdate(header.userToUpdate).ok) return `the machine slot in the downloaded header ("${header.userToUpdate}") is not 1 to 6.`;
	return null;
}

async function sendLine(sender: UploadSender, header: UploadHeader, line: UploadLine, transCount: number, log: (m: string) => void): Promise<UploadStop | null> {
	const recId = checkPcdRecId(line.pcdRecId);
	if (!recId.ok) return stopFor(line, 'This line cannot be sent', invalidLineText(line.pcdRecId, 'its line id is not valid.'));
	if (line.counted === null) return stopFor(line, 'This line cannot be sent', invalidLineText(line.pcdRecId, 'its stored total cannot be read.'));
	const quantity = checkUploadQuantity(line.counted);
	if (!quantity.ok) return stopFor(line, 'This line cannot be sent', invalidLineText(line.pcdRecId, quantity.message));

	const result = await sender.insertDetail({
		transCount,
		location: header.location,
		invId: header.invId,
		localId: line.id,
		pcdRecId: line.pcdRecId,
		counted: quantity.value,
		userToUpdate: header.userToUpdate,
	});
	switch (result.kind) {
		case 'ok': {
			const answer = readInsertAnswer(result.value);
			if (answer.kind === 'ok') return null;
			log(`line ${line.pcdRecId} (transCount ${transCount}) not saved; the server answered: ${result.value}`);
			return stopFor(line, answer.title, answer.message);
		}
		case 'timeout':
			return stopFor(line, 'The server did not answer', `${result.message} ${maybeSavedNote(line.pcdRecId)}`);
		case 'unreachable':
			return stopFor(line, 'Connection lost', `${result.message} ${maybeSavedNote(line.pcdRecId)}`, result.detail);
		case 'unparseable':
			return stopFor(line, 'Unexpected answer from the server', `${result.message} ${maybeSavedNote(line.pcdRecId)}`, result.detail);
		case 'fault':
			return stopFor(line, 'The server rejected the request', `${result.message} Your counts are still on this device.`);
		case 'invalidInput':
			return stopFor(line, 'This line cannot be sent', invalidLineText(line.pcdRecId, result.message));
		case 'noResults':
			return stopFor(line, 'Unexpected answer from the server', `${result.message} ${maybeSavedNote(line.pcdRecId)}`);
	}
}

export async function runUpload(store: UploadStore, sender: UploadSender, header: UploadHeader, options: UploadOptions = {}): Promise<UploadOutcome> {
	const log = options.log ?? (() => undefined);
	const total = await store.pendingCount();
	const headerProblem = checkUploadHeader(header);
	if (headerProblem) {
		return { kind: 'stopped', total, sent: 0, stop: { pcdRecId: null, reference: '', title: 'This count cannot be uploaded', message: invalidHeaderText(headerProblem), detail: '' } };
	}

	let sent = 0;
	const finish = async (kind: UploadOutcome['kind'], stop?: UploadStop): Promise<UploadOutcome> => {
		// Only a run that sent at least one line is remembered as the last upload.
		if (sent > 0) await store.recordUpload((options.now?.() ?? new Date()).toISOString(), sent);
		return stop ? { kind, total, sent, stop } : { kind, total, sent };
	};

	let afterId = 0;
	let transCount = 0;
	for (;;) {
		const batch = await store.pendingLinesAfter(afterId, BATCH);
		if (batch.length === 0) return finish('completed');
		for (const line of batch) {
			if (options.delayBeforeLineMs) await new Promise<void>((resolve) => setTimeout(resolve, options.delayBeforeLineMs));
			if (options.shouldCancel?.()) return finish('cancelled');
			transCount++;
			options.onProgress?.({ row: transCount, total, pcdRecId: line.pcdRecId });
			const stop = await sendLine(sender, header, line, transCount, log);
			if (stop) return finish('stopped', stop);
			await store.markUploaded(line.pcdRecId);
			sent++;
			afterId = line.id;
		}
	}
}
