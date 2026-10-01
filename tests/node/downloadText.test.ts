import { describe, expect, it } from 'vitest';
import { d8Message, discardButtonText, formatElapsed, machineChangeNote, notDownloadableCauses, stalledMessage } from '../../src/domain/downloadText';

describe('Download screen texts', () => {
	it('D8 prompt and button', () => {
		expect(d8Message(5)).toBe('5 counted lines on this device have not been uploaded. Downloading will discard them.');
		expect(d8Message(1)).toBe('1 counted line on this device has not been uploaded. Downloading will discard them.');
		expect(discardButtonText(5)).toBe('Discard 5 counted lines and download');
		expect(discardButtonText(1)).toBe('Discard 1 counted line and download');
	});

	it('machine-name note only when the names differ', () => {
		expect(machineChangeNote('UN3', 'UN', 'CV')).toBe('The count now on this device for CV was downloaded for machine UN. This download will use machine UN3 from Settings.');
		expect(machineChangeNote('UN3', 'UN3', 'V2')).toBeNull();
		expect(machineChangeNote('UN3', null, 'V2')).toBeNull();
		expect(machineChangeNote('', 'UN', 'V2')).toBeNull();
	});

	it('not-downloadable causes name the count, location and machine', () => {
		expect(notDownloadableCauses('999999', 'V2', 'ZZ9')).toEqual([
			'Count 999999 does not exist; check the number.',
			'Count 999999 is cancelled or already posted to stock.',
			'Count 999999 belongs to another location, not V2.',
			"Machine ZZ9 is not one of the count's machine users in the ERP.",
		]);
	});

	it('stalled message (§3.4)', () => {
		expect(stalledMessage(3000, 11131)).toBe('Server returned 3000 of 11131 rows — restart download.');
	});

	it.each([
		[0, '0:00'],
		[999, '0:00'],
		[61_000, '1:01'],
		[3_599_000, '59:59'],
		[3_661_000, '1:01:01'],
	])('formats %i ms as %s', (ms, text) => expect(formatElapsed(ms)).toBe(text));
});

describe('incomplete answer (header without lines)', () => {
	it('explains a server failure, not a wrong count', async () => {
		const { incompleteMessage } = await import('../../src/domain/downloadText');
		expect(incompleteMessage('9', 36)).toBe(
			'The server found count 9 but did not send its lines (it answered after 36 s). This usually means the server timed out while preparing them. Try again; if it keeps happening, the ERP database may be busy or locked.',
		);
	});
});

describe('no lines, no barcodes', () => {
	it('texts', async () => {
		const { noLinesMessage, NO_BARCODES_NOTE } = await import('../../src/domain/downloadText');
		expect(noLinesMessage('12', 'V2')).toBe('This count has no lines. Count 12 exists at V2, but the server lists no lines for it, so there is nothing to download.');
		expect(NO_BARCODES_NOTE).toBe("This count has no barcodes. Scanning product barcodes won't find items; use the reference or the QR sticker.");
	});
});
