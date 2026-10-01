/**
 * DEBUG ONLY — never in a release build. Rendered by Settings only when
 * __DEBUG_TOOLS__ is true (webpack DefinePlugin), so release builds drop this
 * module. Marks N lines of the live sheet as counted (updated = '1', counted + 1)
 * so the D8 prompt can be tested before the Scan screen exists (§14 step 6), and
 * marks N counted lines as uploaded (updated = '2') so the Items lists and the
 * counters can be tested before Upload exists (§14 step 8). Also sets the
 * debug-only pause before each uploaded line (./uploadDelay.ts, §14 step 9).
 */
import { Dialogs, PropertyChangeData } from '@nativescript/core';
import * as React from 'react';
import type { LocationDb } from '../storage/locationDb';
import { getUploadDelayMs, setUploadDelayMs } from './uploadDelay';

/** The first `n` not-counted lines by RowNumber become counted, each with its stored total + 1. */
export async function markLinesCounted(db: LocationDb, n: number): Promise<number> {
	const lines = await db.listLines('0', 0, n);
	for (const line of lines) await db.setCount(line.pcdRecId, (line.counted ?? 0n) + 1000n);
	return lines.length;
}

/** The first `n` counted lines by RowNumber become uploaded, exactly as after an "ok" from InsertDetail. Nothing is sent. */
export async function markLinesUploaded(db: LocationDb, n: number): Promise<number> {
	const lines = await db.listLines('1', 0, n);
	for (const line of lines) await db.markUploaded(line.pcdRecId);
	return lines.length;
}

interface Props {
	locationDb: LocationDb | null;
	/** Settings re-reads its own numbers after a debug action. */
	onChanged: () => void;
	openScanLine: (lineId: string) => void;
}

export function DebugTools({ locationDb, onChanged, openScanLine }: Props) {
	const [n, setN] = React.useState('5');
	const [lineId, setLineId] = React.useState('');
	const [delay, setDelay] = React.useState(String(getUploadDelayMs()));
	const validN = !!locationDb && /^[1-9][0-9]{0,3}$/.test(n);

	async function run(what: string, action: (db: LocationDb, n: number) => Promise<number>) {
		if (!locationDb) return;
		try {
			const marked = await action(locationDb, Number(n));
			console.log(`[debug] marked ${marked} lines as ${what}`);
			onChanged();
			await Dialogs.alert({ title: 'Debug', message: `${marked} lines marked as ${what}.`, okButtonText: 'OK' });
		} catch (error) {
			await Dialogs.alert({ title: 'Debug', message: String(error), okButtonText: 'OK' });
		}
	}

	return (
		<stackLayout className="card">
			<label className="card-title" text="Debug tools (debug builds only)" />
			<label
				className="field-label"
				textWrap={true}
				text="Number of lines. Mark as counted: the first not-counted lines (tests the download warning, D8). Mark as uploaded: the first counted lines, without sending anything (tests Items and the counters)."
			/>
			<textField text={n} keyboardType="integer" maxLength={4} onTextChange={(args: PropertyChangeData) => setN(String(args.value ?? ''))} />
			<button className="btn-secondary" text="Mark lines as counted" isEnabled={validN} onTap={() => run('counted', markLinesCounted)} />
			<button className="btn-secondary" text="Mark counted lines as uploaded" isEnabled={validN} onTap={() => run('uploaded', markLinesUploaded)} />
			<label className="field-label" textWrap={true} text="Upload: pause before each line, in ms (0 = none). Gives time to switch the network off in the middle of an upload." />
			<textField
				text={delay}
				keyboardType="integer"
				maxLength={5}
				onTextChange={(args: PropertyChangeData) => {
					const value = String(args.value ?? '');
					setDelay(value);
					setUploadDelayMs(/^[0-9]{1,5}$/.test(value) ? Number(value) : 0);
				}}
			/>
			<label className="field-label" textWrap={true} text="Open Scan in display mode for a line id (what Items does when a row is tapped)." />
			<textField text={lineId} hint="Line id, e.g. 47842" keyboardType="integer" maxLength={18} onTextChange={(args: PropertyChangeData) => setLineId(String(args.value ?? ''))} />
			<button className="btn-secondary" text="Open line in Scan" isEnabled={!!locationDb && /^[0-9]{1,18}$/.test(lineId)} onTap={() => openScanLine(lineId)} />
		</stackLayout>
	);
}
