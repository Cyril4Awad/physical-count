/** Operator texts for the Download screen (REBUILD_PLAN §6.1). Pure, so they are unit-tested. */

export function d8Message(pending: number): string {
	return `${pending} counted line${pending === 1 ? '' : 's'} on this device ${pending === 1 ? 'has' : 'have'} not been uploaded. Downloading will discard them.`;
}

export function discardButtonText(pending: number): string {
	return `Discard ${pending} counted line${pending === 1 ? '' : 's'} and download`;
}

/** Plain-words note when the Settings machine name differs from the one the current sheet was downloaded for. */
export function machineChangeNote(settingsMachine: string, sheetMachine: string | null, location: string): string | null {
	if (!sheetMachine || !settingsMachine || sheetMachine === settingsMachine) return null;
	return `The count now on this device for ${location} was downloaded for machine ${sheetMachine}. This download will use machine ${settingsMachine} from Settings.`;
}

export const NOT_DOWNLOADABLE_TITLE = 'Selected Inventory Not Download Or Does Not Exist!!!';

/** Likely causes (§3.3 step 5). */
export function notDownloadableCauses(countNumber: string, location: string, machine: string): string[] {
	return [
		`Count ${countNumber} does not exist; check the number.`,
		`Count ${countNumber} is cancelled or already posted to stock.`,
		`Count ${countNumber} belongs to another location, not ${location}.`,
		`Machine ${machine} is not one of the count's machine users in the ERP.`,
	];
}

/** Header found but no lines (manifest reason `incomplete`). */
export function incompleteMessage(countNumber: string, seconds: number): string {
	return `The server found count ${countNumber} but did not send its lines (it answered after ${seconds} s). This usually means the server timed out while preparing them. Try again; if it keeps happening, the ERP database may be busy or locked.`;
}

/** A phyDetails entry with RowsCount 0 (manifest reason `noLines`). */
export function noLinesMessage(countNumber: string, location: string): string {
	return `This count has no lines. Count ${countNumber} exists at ${location}, but the server lists no lines for it, so there is nothing to download.`;
}

/** Download summary note when lines exist but there are no barcodes. */
export const NO_BARCODES_NOTE = "This count has no barcodes. Scanning product barcodes won't find items; use the reference or the QR sticker.";

export function stalledMessage(rowsStored: number, rowsCount: number): string {
	return `Server returned ${rowsStored} of ${rowsCount} rows — restart download.`;
}

/** m:ss, or h:mm:ss from one hour. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const two = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
