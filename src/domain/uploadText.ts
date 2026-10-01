/**
 * Operator texts for the Upload screen and what the service's InsertDetail
 * answer means (REBUILD_PLAN §6.2). Pure, so every text is unit-tested.
 */

const STILL_HERE = 'Your counts are still on this device.';

export const NO_COUNTED_ITEMS = 'No Counted Items Found.';

export function confirmText(pending: number): string {
	return `This Physical Count Contains ${pending} Items. Upload?`;
}

export function rowText(row: number, total: number): string {
	return `Row ${row} / ${total}`;
}

export type InsertAnswer =
	| { kind: 'ok' }
	/** The header check at transCount 1 refused the whole run (S4). */
	| { kind: 'refused'; title: string; message: string }
	/** `<UPDATE statement>:<SQL error>`: only the SQL error is shown; the caller logs the full text. */
	| { kind: 'sqlError'; title: string; message: string }
	| { kind: 'unexpected'; title: string; message: string };

const REFUSALS: Record<string, { title: string; message: string }> = {
	'This Physical Count Was Cancelled': {
		title: 'This count was cancelled',
		message: `The server refused the upload: this physical count was cancelled in the ERP. Nothing was sent. ${STILL_HERE}`,
	},
	'This Physical Count Was Already Updated To Stock': {
		title: 'This count is already posted',
		message: `The server refused the upload: this physical count was already updated to stock in the ERP, so it no longer accepts counts. Nothing was sent. ${STILL_HERE}`,
	},
	'This Physical Count Does Not Exist': {
		title: 'This count does not exist on the server',
		message: `The server refused the upload: it has no physical count with this number. Nothing was sent. ${STILL_HERE}`,
	},
};

const UPDATE_STATEMENT = /^Update tbl_PhysicalCountDetail/i;
const MAX_SHOWN = 300;

/** Reads `InsertDetailResult`. Only exactly `ok` means the line was written (§6.2 step 5). */
export function readInsertAnswer(text: string): InsertAnswer {
	if (text === 'ok') return { kind: 'ok' };
	const trimmed = text.trim();
	const refusal = REFUSALS[trimmed];
	if (refusal) return { kind: 'refused', ...refusal };
	if (UPDATE_STATEMENT.test(trimmed)) {
		// The statement itself has no ':' (every value in it passed §3.7), so the SQL error starts after the first one.
		const colon = trimmed.indexOf(':');
		const sqlError = colon >= 0 ? trimmed.slice(colon + 1).trim() : '';
		return {
			kind: 'sqlError',
			title: 'The server could not save this line',
			message: `${(sqlError || 'The database reported an error without a message.').slice(0, MAX_SHOWN)} ${STILL_HERE}`,
		};
	}
	return {
		kind: 'unexpected',
		title: 'Unexpected answer from the server',
		message: `The server answered "${trimmed.slice(0, MAX_SHOWN)}" instead of "ok", so the upload stopped. ${STILL_HERE}`,
	};
}

/** After a timeout or a lost connection the service may or may not have run the UPDATE. */
export function maybeSavedNote(pcdRecId: string): string {
	return `Line ${pcdRecId} may already have been saved on the server. It is still marked as not uploaded here, and sending it again is safe. ${STILL_HERE}`;
}

export function invalidHeaderText(problem: string): string {
	return `The count on this device cannot be uploaded: ${problem} Nothing was sent. Download the count again. ${STILL_HERE}`;
}

export function invalidLineText(pcdRecId: string, problem: string): string {
	return `Line ${pcdRecId} cannot be sent: ${problem} Correct its total in Scan, then upload again. ${STILL_HERE}`;
}

const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;

export function sentText(sent: number): string {
	return sent === 0 ? 'No lines were sent.' : `${lines(sent)} sent.`;
}

export function pendingText(pending: number): string {
	return pending === 0 ? 'No lines are waiting for upload.' : `${lines(pending)} still waiting for upload.`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Home's "Last upload" line, in the device's local time: `01/10/2026 08:15 · 7 lines`. Null when there is nothing to show. */
export function lastUploadText(at: string, sent: number): string | null {
	const date = new Date(at);
	if (!at || Number.isNaN(date.getTime()) || sent < 1) return null;
	return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())} · ${lines(sent)}`;
}
