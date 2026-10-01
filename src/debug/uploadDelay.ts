/**
 * DEBUG ONLY — never in a release build (loaded only when __DEBUG_TOOLS__ is true).
 * A pause before each uploaded line, so "the network drops in the middle of an upload"
 * can be tested by hand on a count of a few lines (§14 step 9).
 */
import { ApplicationSettings } from '@nativescript/core';

const KEY = 'debugUploadDelayMs';
export const MAX_UPLOAD_DELAY_MS = 10_000;

export function getUploadDelayMs(): number {
	const value = ApplicationSettings.getNumber(KEY, 0);
	return Number.isInteger(value) && value > 0 && value <= MAX_UPLOAD_DELAY_MS ? value : 0;
}

export function setUploadDelayMs(value: number): void {
	if (value > 0) ApplicationSettings.setNumber(KEY, Math.min(Math.floor(value), MAX_UPLOAD_DELAY_MS));
	else ApplicationSettings.remove(KEY);
}
