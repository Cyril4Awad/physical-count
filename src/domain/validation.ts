import { DEFAULT_PAGE_SIZE } from '../config';
import { accept, Check, reject } from './check';

export { DEFAULT_PAGE_SIZE };

/**
 * Input checks enforced by the app (REBUILD_PLAN §3.7, D9). The service
 * concatenates every parameter into SQL, so only these shapes are ever sent.
 * The quantity check is in ./decimal.ts; the TableName check is in
 * parse/manifest.ts (exact) and soap/envelopes.ts (shape).
 */

export const MAX_PAGE_SIZE = 5000;

/** Location code, kept exactly as typed (no trimming, no case change). */
export function checkLocationCode(text: string): Check<string> {
	if (text === '') return reject('Enter the location code.');
	if (!/^[A-Za-z0-9]{1,2}$/.test(text)) return reject('The location code is 1 or 2 letters or digits.');
	return accept(text);
}

/** Machine name: the width of Pch_MachUserN is 5 (S17). */
export function checkMachineName(text: string): Check<string> {
	if (text === '') return reject('Enter the machine name.');
	if (!/^[A-Za-z0-9]{1,5}$/.test(text)) return reject('The machine name is 1 to 5 letters or digits.');
	return accept(text);
}

/**
 * Server address: host or host:port, without http:// and without a path
 * (legacy format). Format check only; any host is accepted (§9.1).
 */
export function checkServerAddress(text: string): Check<string> {
	if (text === '') return reject('Enter the server address.');
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return reject('Type the server without http:// (for example 192.168.1.10 or erp-server:8080).');
	if (text.includes('/')) return reject('Type only the server name or address, without a path.');

	const match = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/.exec(text);
	if (!match) return reject('The server address may only contain letters, digits, dots, dashes and an optional :port.');
	const [, host, port] = match;
	if (host.split('.').some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) {
		return reject('The server name is not valid.');
	}
	if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return reject('The port must be between 1 and 65535.');
	return accept(text);
}

/** Physical count number (`Extras`, `uInvID`). */
export function checkCountNumber(text: string): Check<string> {
	const value = text.trim();
	if (value === '') return reject('Enter the physical count number.');
	if (!/^[0-9]{1,18}$/.test(value)) return reject('The physical count number is digits only.');
	return accept(value);
}

/** Detail line id sent to InsertDetail. The caller also checks it exists in the local sheet (S21). */
export function checkPcdRecId(text: string): Check<string> {
	if (!/^[0-9]{1,18}$/.test(text)) return reject(`Invalid line id "${text}".`);
	return accept(text);
}

export function checkUserToUpdate(text: string): Check<string> {
	if (!/^[1-6]$/.test(text)) return reject(`Invalid machine slot "${text}" in the downloaded header.`);
	return accept(text);
}

export function checkTransCount(value: number): Check<number> {
	if (!Number.isSafeInteger(value) || value < 1) return reject(`Invalid transCount ${value}.`);
	return accept(value);
}

export function checkPageSize(text: string): Check<number> {
	const value = text.trim();
	if (value === '') return reject('Enter the download page size.');
	if (!/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE_SIZE) {
		return reject(`The download page size is a whole number from 1 to ${MAX_PAGE_SIZE}.`);
	}
	return accept(Number(value));
}
