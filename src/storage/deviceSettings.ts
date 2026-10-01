import { ApplicationSettings } from '@nativescript/core';
import type { Check } from '../domain/check';
import { checkMachineName, checkPageSize, DEFAULT_PAGE_SIZE } from '../domain/validation';

/**
 * The global device settings (REBUILD_PLAN §2.2, §4.1), kept in
 * ApplicationSettings like legacy SharedPreferences: not per profile.
 */

const MACHINE_NAME = 'machineName';
const PAGE_SIZE = 'downloadPageSize';
const SCANNER_INPUT = 'scannerInput';

/** '' until the operator types one. */
export function getMachineName(): string {
	return ApplicationSettings.getString(MACHINE_NAME, '');
}

export function setMachineName(text: string): Check<string> {
	const result = checkMachineName(text);
	if (result.ok) ApplicationSettings.setString(MACHINE_NAME, result.value);
	return result;
}

/** Default 1000 (Q13); a stored value that is no longer valid falls back to the default. */
export function getPageSize(): number {
	const stored = checkPageSize(String(ApplicationSettings.getNumber(PAGE_SIZE, DEFAULT_PAGE_SIZE)));
	return stored.ok ? stored.value : DEFAULT_PAGE_SIZE;
}

export function setPageSize(text: string): Check<number> {
	const result = checkPageSize(text);
	if (result.ok) ApplicationSettings.setNumber(PAGE_SIZE, result.value);
	return result;
}

/**
 * How the Scan screen's scan field takes the scanner's output (§9.3), Settings → Advanced:
 * - `keyEvents` (default): no input-method connection (`TYPE_NULL`); the scanner must send key events.
 * - `textInput`: a normal text field with suggestions off, for a scanner that commits text through an input method.
 * The soft keyboard stays hidden in both.
 */
export type ScannerInput = 'keyEvents' | 'textInput';

export function getScannerInput(): ScannerInput {
	return ApplicationSettings.getString(SCANNER_INPUT, 'keyEvents') === 'textInput' ? 'textInput' : 'keyEvents';
}

export function setScannerInput(mode: ScannerInput): void {
	ApplicationSettings.setString(SCANNER_INPUT, mode === 'textInput' ? 'textInput' : 'keyEvents');
}

/** Test helper: back to first-run state. */
export function clearDeviceSettings(): void {
	ApplicationSettings.remove(MACHINE_NAME);
	ApplicationSettings.remove(PAGE_SIZE);
	ApplicationSettings.remove(SCANNER_INPUT);
}
