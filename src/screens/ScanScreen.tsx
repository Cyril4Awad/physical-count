import { EventData, PropertyChangeData, TextField } from '@nativescript/core';
import * as React from 'react';
import type { Check } from '../domain/check';
import { cancelLastScan, CountResult, scan, updateLastScanQty, updateTotalScanned } from '../domain/countRules';
import { allowedDecimals, formatQuantity, Milli } from '../domain/decimal';
import { expiryShown, pickRowText, showQty } from '../domain/itemText';
import { lookupScan } from '../domain/lookup';
import { Beeper } from '../platform/beeper';
import { ScanField } from '../platform/scanField';
import { getScannerInput } from '../storage/deviceSettings';
import type { Line } from '../storage/locationDb';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';

/**
 * Scan (REBUILD_PLAN §2.1, §5, §9.3): keyboard-wedge scan field, lookup in the
 * legacy order, line details, the three correction buttons, sounds, and the
 * Pick item overlay. With `lineId` (from Items) the line is shown without counting.
 */

type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null;

interface Shown {
	line: Line;
	lastScanned: Milli;
	lastScanEnabled: boolean;
}

const PICK_LIMIT = 100;
const log = (message: string) => console.log(`[scan] ${message}`);

function Detail({ label, value, col = 0, row = 0, colSpan = 1 }: { label: string; value: string; col?: number; row?: number; colSpan?: number }) {
	return (
		<stackLayout col={col} row={row} colSpan={colSpan}>
			<label className="field-label" text={label} />
			<label className="field-value" textWrap={true} text={value || '—'} />
		</stackLayout>
	);
}

/** A Pick item row; its texts come from `pickRowText`, which the Node tests pin down. */
function PickRow({ line, showExpiry }: { line: Line; showExpiry: boolean }) {
	const row = pickRowText(line, showExpiry);
	return (
		<stackLayout>
			<gridLayout columns="*, auto">
				<label col={0} className="field-value" textWrap={true} text={row.title} />
				<label col={1} className="pick-id" text={row.id} />
			</gridLayout>
			{!!row.reference && <label className="pick-ref" textWrap={true} text={row.reference} />}
			<label className="field-label" textWrap={true} text={row.description} />
			<label className="pick-counted" text={row.counted} />
		</stackLayout>
	);
}

export function ScanScreen({ lineId }: { lineId?: string }) {
	const { locationDb, setBackGuard } = useApp();
	const [blocked, setBlocked] = React.useState<string | null>(null);
	const [decimals, setDecimals] = React.useState(0);
	const [showExpiry, setShowExpiry] = React.useState(true);
	const [shown, setShown] = React.useState<Shown | null>(null);
	const [totalText, setTotalText] = React.useState('');
	const [lastText, setLastText] = React.useState('');
	const [status, setStatus] = React.useState<Status>(null);
	const [pick, setPick] = React.useState<{ query: string; results: Line[] } | null>(null);

	const decimalsRef = React.useRef(0);
	const showExpiryRef = React.useRef(true);
	// The scanner input chosen in Settings → Advanced, read once when Scan opens.
	const scannerInput = React.useRef(getScannerInput());
	const beeper = React.useRef<Beeper | null>(null);
	const queue = React.useRef<Promise<void>>(Promise.resolve());
	const pickSearch = React.useRef(0);
	const pickOpen = React.useRef(false);
	pickOpen.current = !!pick;
	const handleScanRef = React.useRef<(value: string) => Promise<void>>(async () => undefined);
	const scanField = React.useRef(new ScanField((value) => enqueue(() => handleScanRef.current(value))));

	/** Scans and button actions run one at a time, in order, so fast scans never lose a count. */
	function enqueue(action: () => Promise<void>) {
		queue.current = queue.current.then(action).catch((error) => {
			log(`error: ${String(error)}`);
			setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
			beeper.current?.bad();
		});
	}

	// One ToneGenerator for the life of the screen.
	React.useEffect(() => {
		beeper.current = new Beeper();
		const field = scanField.current;
		return () => {
			beeper.current?.release();
			beeper.current = null;
			field.detach();
		};
	}, []);

	function display(line: Line, lastScanned: Milli, lastScanEnabled: boolean) {
		setShown({ line, lastScanned, lastScanEnabled });
		setTotalText(formatQuantity(line.counted ?? 0n));
		setLastText(lastScanEnabled ? formatQuantity(lastScanned) : '');
	}

	function clearLine() {
		setShown(null);
		setTotalText('');
		setLastText('');
	}

	// Scan is only usable on a complete sheet with no download in progress (§5.1).
	React.useEffect(() => {
		(async () => {
			if (!locationDb) return setBlocked('Select a location in Settings first.');
			const [sheet, inProgress] = await Promise.all([locationDb.sheetInfo(), locationDb.isDownloadInProgress()]);
			if (inProgress) return setBlocked('A download is in progress. Finish or abandon it in Download first.');
			if (!sheet) return setBlocked('No count downloaded for this location yet.');
			const d = allowedDecimals(sheet.spDecNo);
			decimalsRef.current = d;
			setDecimals(d);
			showExpiryRef.current = expiryShown(sheet.spExpiry);
			setShowExpiry(showExpiryRef.current);
			if (lineId) {
				const line = await locationDb.getLine(lineId);
				if (line) {
					display(line, 0n, false);
					setStatus({ kind: 'info', text: `Viewing line ${lineId} (not counted). Scan to count.` });
				} else setStatus({ kind: 'error', text: `Line ${lineId} is not in this count.` });
			}
		})();
	}, [locationDb, lineId]);

	// Back closes Pick item first.
	React.useEffect(() => {
		if (!pick) {
			setBackGuard(null);
			return;
		}
		setBackGuard(async () => {
			closePick();
			return false;
		});
		return () => setBackGuard(null);
	}, [!!pick]);

	if (blocked || !locationDb) {
		return (
			<gridLayout rows="auto, *">
				<Header title="Scan" />
				<label row={1} className="content warning" textWrap={true} text={blocked ?? '…'} />
			</gridLayout>
		);
	}
	const db = locationDb;

	/** Pick item lines: oldest expiry first, then RowNumber. With expiry hidden (SP_Expiry N), RowNumber only. */
	const searchForPick = (prefix: string) => db.searchByReferencePrefix(prefix, PICK_LIMIT, { byExpiry: showExpiryRef.current });

	/** +1 on a line (a scan, or a pick from Pick item): §5.3 scan rule. */
	async function countLine(pcdRecId: string, value: string) {
		const current = await db.getLine(pcdRecId);
		if (!current) throw new Error(`Line ${pcdRecId} is not in this count.`);
		if (current.counted === null) throw new Error(`The stored total of line ${pcdRecId} cannot be read.`);
		const result = scan(current.counted);
		if (!result.ok) {
			display(current, 0n, false);
			setStatus({ kind: 'error', text: result.message });
			beeper.current?.bad();
			return;
		}
		await db.setCount(pcdRecId, result.value.total);
		const updated = (await db.getLine(pcdRecId)) ?? current;
		display(updated, result.value.lastScanned, result.value.lastScanEnabled);
		setStatus({ kind: 'ok', text: `+1  ${updated.reference}  (${value})` });
		beeper.current?.good();
		log(`counted ${pcdRecId} → ${formatQuantity(result.value.total)} (${value})`);
	}

	handleScanRef.current = async (raw: string) => {
		// A scan while Pick item is open (focus stays on the scan field) closes it and counts as a normal scan.
		if (pickOpen.current) {
			pickOpen.current = false;
			setPick(null);
		}
		const result = await lookupScan(raw, db.lookupRepository());
		switch (result.kind) {
			case 'empty':
				return;
			case 'found':
				return countLine(result.lineId, result.value);
			case 'pick':
				log(`pick for "${result.value}"`);
				setPick({ query: result.value, results: await searchForPick(result.value) });
				return;
			case 'invalidQr':
				clearLine();
				setStatus({ kind: 'error', text: `Invalid QR: ${result.value}` });
				beeper.current?.bad();
				log(`invalid QR "${result.value}"`);
				return;
			case 'notFound':
				clearLine();
				setStatus({ kind: 'error', text: `Item Not Found: ${result.value}` });
				beeper.current?.bad();
				log(`not found "${result.value}"`);
				return;
		}
	};

	/** The three correction buttons (§5.3): the formula from the fields on screen, then one write. */
	function correct(name: string, compute: () => Check<CountResult>) {
		enqueue(async () => {
			const current = shown;
			if (!current) return;
			const result = compute();
			if (!result.ok) {
				setStatus({ kind: 'error', text: result.message });
				beeper.current?.bad();
				return;
			}
			await db.setCount(current.line.pcdRecId, result.value.total);
			const updated = (await db.getLine(current.line.pcdRecId)) ?? current.line;
			display(updated, result.value.lastScanned, result.value.lastScanEnabled);
			setStatus({ kind: 'ok', text: `${name}: total ${formatQuantity(result.value.total)}` });
			log(`${name} ${current.line.pcdRecId} → ${formatQuantity(result.value.total)}`);
		});
		scanField.current.rearm();
	}

	function closePick() {
		setPick(null);
		scanField.current.rearm();
	}

	function searchPick(query: string) {
		const ticket = ++pickSearch.current;
		setPick((p) => (p ? { ...p, query } : p));
		void searchForPick(query).then((results) => {
			if (ticket === pickSearch.current) setPick((p) => (p ? { ...p, results } : p));
		});
	}

	const line = shown?.line;
	const qtyKeyboard = decimals === 0 ? 'integer' : 'number';

	return (
		<gridLayout rows="auto, *">
			<Header title="Scan" />
			<scrollView row={1}>
				<stackLayout className="content">
					<textField
						className="scan-field"
						hint="Scan, or type and press Enter"
						onLoaded={(args: EventData) => scanField.current.attach(args.object as TextField, scannerInput.current)}
						onTap={() => scanField.current.rearm()}
					/>
					{status && <label className={status.kind === 'error' ? 'scan-status error' : status.kind === 'ok' ? 'scan-status ok' : 'scan-status hint'} textWrap={true} text={status.text} />}

					<gridLayout className="card" columns="*, *" rows="auto, auto, auto, auto, auto">
						<Detail row={0} col={0} label="Id" value={line?.pcdRecId ?? ''} />
						<Detail row={0} col={1} label="Reference" value={line?.reference ?? ''} />
						<Detail row={1} col={0} colSpan={2} label="Description" value={line?.description ?? ''} />
						<Detail row={2} col={0} label="Colour" value={line?.colorDescription ?? ''} />
						<Detail row={2} col={1} label="Avlb Qty" value={line ? showQty(line.systemQty) : ''} />
						{showExpiry && <Detail row={3} col={0} label="Expiry" value={line?.expiry ?? ''} />}
						{showExpiry && <Detail row={3} col={1} label="Lot" value={line?.batch ?? ''} />}
					</gridLayout>

					<label className="field-label" text="Total Qty Scanned" />
					<gridLayout columns="*, auto">
						<textField
							col={0}
							className="qty-field"
							text={totalText}
							keyboardType={qtyKeyboard}
							isEnabled={!!line}
							onTextChange={(args: PropertyChangeData) => setTotalText(String(args.value ?? ''))}
						/>
						<button
							col={1}
							className="btn-small qty-button"
							text="Update Total Scanned"
							isEnabled={!!line}
							onTap={() => correct('Update Total Scanned', () => updateTotalScanned(totalText, decimalsRef.current, shown?.lastScanned ?? 0n, shown?.lastScanEnabled ?? false))}
						/>
					</gridLayout>

					<label className="field-label" text="Last Scanned" />
					<gridLayout columns="*, auto">
						<textField
							col={0}
							className="qty-field"
							text={lastText}
							keyboardType={qtyKeyboard}
							isEnabled={!!shown?.lastScanEnabled}
							onTextChange={(args: PropertyChangeData) => setLastText(String(args.value ?? ''))}
						/>
						<button
							col={1}
							className="btn-small qty-button"
							text="Update Last Scan Qty"
							isEnabled={!!shown?.lastScanEnabled}
							onTap={() => correct('Update Last Scan Qty', () => updateLastScanQty(totalText, lastText, decimalsRef.current))}
						/>
					</gridLayout>
					<button
						className="btn-danger"
						text="Cancel Last Scan"
						isEnabled={!!shown?.lastScanEnabled}
						onTap={() => correct('Cancel Last Scan', () => cancelLastScan(totalText, lastText, decimalsRef.current))}
					/>
				</stackLayout>
			</scrollView>

			{pick && (
				<gridLayout row={0} rowSpan={2} rows="auto, auto, auto, *, auto" className="overlay">
					<label row={0} className="card-title overlay-title" text="Pick item" />
					<label row={1} className="hint" textWrap={true} text={`${pick.results.length}${pick.results.length === PICK_LIMIT ? '+' : ''} lines start with this reference. Tap one to count it.`} />
					<textField row={2} text={pick.query} hint="Reference starts with…" autocorrect={false} autocapitalizationType="none" onTextChange={(args: PropertyChangeData) => searchPick(String(args.value ?? ''))} />
					<scrollView row={3}>
						<stackLayout>
							{pick.results.map((l) => (
								<stackLayout
									key={l.pcdRecId}
									className="pick-row"
									onTap={() => {
										setPick(null);
										enqueue(() => countLine(l.pcdRecId, pick.query));
										scanField.current.rearm();
									}}
								>
									<PickRow line={l} showExpiry={showExpiry} />
								</stackLayout>
							))}
						</stackLayout>
					</scrollView>
					<button row={4} className="btn-secondary" text="Close" onTap={closePick} />
				</gridLayout>
			)}
		</gridLayout>
	);
}
