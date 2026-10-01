import { Dialogs, PropertyChangeData } from '@nativescript/core';
import * as React from 'react';
import { checkCountNumber, checkMachineName } from '../domain/validation';
import {
	d8Message,
	discardButtonText,
	formatElapsed,
	machineChangeNote,
	incompleteMessage,
	NO_BARCODES_NOTE,
	noLinesMessage,
	NOT_DOWNLOADABLE_TITLE,
	notDownloadableCauses,
	stalledMessage,
} from '../domain/downloadText';
import { deviceInfoText } from '../platform/deviceInfo';
import { keepScreenOn } from '../platform/keepScreenOn';
import { pageSourceFor, SoapClient } from '../soap/client';
import { httpTransport } from '../soap/httpTransport';
import { getMachineName, getPageSize } from '../storage/deviceSettings';
import { runDownload } from '../storage/download';
import { describeDownloadError, startNewDownload } from '../storage/downloadFlow';
import type { PullStatus } from '../storage/locationDb';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';

/**
 * Download (REBUILD_PLAN §2.1, §6.1): count number → D8 check → InitPullTables →
 * staged pages → swap. After an error or Cancel: Continue (never calls
 * InitPullTables), Restart (D8 again, then InitPullTables) or Abandon.
 */

interface TableProgress {
	table: PullStatus['table'];
	header: string;
	rowsStored: number;
	rowsCount: number;
}

interface Summary {
	countNumber: string;
	warehouse: string;
	date: string;
	lines: number;
	barcodes: number;
	elapsedMs: number;
}

type Phase =
	| { kind: 'loading' }
	| { kind: 'enter' }
	| { kind: 'd8'; countNumber: string; pending: number }
	| { kind: 'contacting'; countNumber: string }
	| { kind: 'paging'; countNumber: string; tables: TableProgress[] }
	/** A download exists in tblPullStatus but is not running: after Cancel, an error, a stall, or an app restart. */
	| { kind: 'paused'; countNumber: string; tables: TableProgress[]; title: string; message: string; detail: string; stalled: boolean }
	/** InitPullTables did not start anything: nothing local changed. */
	| { kind: 'startFailed'; countNumber: string; title: string; message: string; detail: string }
	| { kind: 'notDownloadable'; countNumber: string; machine: string }
	| { kind: 'done'; summary: Summary };

const log = (message: string) => console.log(`[download] ${message}`);

function toProgress(statuses: PullStatus[]): TableProgress[] {
	return statuses.map((s) => ({ table: s.table, header: s.displayHeader, rowsStored: s.rowsStored, rowsCount: s.rowsCount }));
}

function ProgressList({ tables }: { tables: TableProgress[] }) {
	return (
		<stackLayout>
			{tables.map((t) => (
				<stackLayout key={t.table} className="progress-row">
					<label className="field-label" textWrap={true} text={t.header} />
					<progress className="progress" value={t.rowsCount === 0 ? 1 : t.rowsStored} maxValue={t.rowsCount === 0 ? 1 : t.rowsCount} />
					<label className="field-value" text={`${t.rowsStored} of ${t.rowsCount} rows`} />
				</stackLayout>
			))}
		</stackLayout>
	);
}

export function DownloadScreen() {
	const { profile, locationDb, navigate, setBackGuard } = useApp();
	const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });
	const [countText, setCountText] = React.useState('');
	const [sheetMachine, setSheetMachine] = React.useState<string | null>(null);
	const [startedAt, setStartedAt] = React.useState<number | null>(null);
	const [now, setNow] = React.useState(Date.now());
	const [cancelling, setCancelling] = React.useState(false);
	const cancelRef = React.useRef(false);
	const cancelTappedAt = React.useRef<number | null>(null);
	const mounted = React.useRef(true);
	const machine = getMachineName();
	const running = phase.kind === 'contacting' || phase.kind === 'paging';

	// Initial state: an interrupted download (Continue / Restart / Abandon) or the count number step.
	React.useEffect(() => {
		mounted.current = true;
		(async () => {
			if (!locationDb) return;
			const [statuses, sheet] = await Promise.all([locationDb.pullStatus(), locationDb.sheetInfo()]);
			setSheetMachine(sheet?.machineName ?? null);
			if (statuses.length > 0) {
				const done = statuses.reduce((n, s) => n + s.rowsStored, 0);
				const total = statuses.reduce((n, s) => n + s.rowsCount, 0);
				setPhase({
					kind: 'paused',
					countNumber: statuses[0].countNumber,
					tables: toProgress(statuses),
					title: 'Download not finished',
					message: `The download of count ${statuses[0].countNumber} stopped at ${done} of ${total} rows.`,
					detail: '',
					stalled: false,
				});
			} else setPhase({ kind: 'enter' });
		})();
		return () => {
			mounted.current = false;
			keepScreenOn(false);
		};
	}, [locationDb]);

	// Elapsed time ticks while running.
	React.useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [running]);

	// Back during a running download asks first (§14 step 6).
	React.useEffect(() => {
		if (!running) {
			setBackGuard(null);
			return;
		}
		setBackGuard(async () => {
			const ok = await Dialogs.confirm({ title: 'Download', message: 'Cancel the download?', okButtonText: 'Cancel download', cancelButtonText: 'Keep downloading' });
			if (ok) requestCancel();
			return false;
		});
		return () => setBackGuard(null);
	}, [running]);

	if (!profile || !locationDb) {
		return (
			<gridLayout rows="auto, *">
				<Header title="Download" />
				<label row={1} className="content warning" textWrap={true} text="Select a location in Settings first." />
			</gridLayout>
		);
	}
	const db = locationDb;
	const location = profile.location;

	function requestCancel() {
		if (cancelRef.current) return;
		cancelRef.current = true;
		cancelTappedAt.current = Date.now();
		setCancelling(true);
		log(`Cancel tapped at ${new Date(cancelTappedAt.current).toISOString()}`);
	}

	function client(): SoapClient {
		return new SoapClient(profile!.serverAddress, httpTransport);
	}

	async function paused(title: string, message: string, detail: string, stalled = false) {
		const statuses = await db.pullStatus();
		if (!mounted.current) return;
		if (statuses.length === 0) return setPhase({ kind: 'enter' });
		setPhase({ kind: 'paused', countNumber: statuses[0].countNumber, tables: toProgress(statuses), title, message, detail, stalled });
	}

	/** Pages until done, cancelled, stalled or failed. Never calls InitPullTables. */
	async function runPages(countNumber: string, t0: number) {
		const initial = toProgress(await db.pullStatus());
		setPhase({ kind: 'paging', countNumber, tables: initial });
		const tables = [...initial];
		const pageSize = getPageSize();
		keepScreenOn(true);
		try {
			const outcome = await runDownload(db, pageSourceFor(client()), {
				pageSize,
				shouldCancel: () => cancelRef.current,
				onProgress: (p) => {
					const i = tables.findIndex((t) => t.table === p.table);
					if (i >= 0) tables[i] = { ...tables[i], rowsStored: p.rowsStored };
					log(`${p.table} ${p.rowsStored} / ${p.rowsCount} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
					if (mounted.current) setPhase({ kind: 'paging', countNumber, tables: [...tables] });
				},
			});
			if (outcome.kind === 'completed') {
				const [sheet, counters, barcodes] = await Promise.all([db.sheetInfo(), db.counters(), db.count('phyBarcodes')]);
				const elapsedMs = Date.now() - t0;
				log(`completed count ${countNumber}: ${counters.lines} lines, ${barcodes} barcodes in ${(elapsedMs / 1000).toFixed(1)} s`);
				setPhase({
					kind: 'done',
					summary: { countNumber: sheet?.countNumber ?? countNumber, warehouse: sheet?.warehouse ?? '', date: sheet?.dateCount ?? '', lines: counters.lines, barcodes, elapsedMs },
				});
			} else if (outcome.kind === 'cancelled') {
				const reacted = cancelTappedAt.current ? Date.now() - cancelTappedAt.current : 0;
				log(`cancelled; ${reacted} ms after Cancel was tapped`);
				await paused('Download cancelled', 'The download was cancelled. The count already on this device is unchanged.', '');
			} else {
				log(`stalled: ${outcome.rowsStored} of ${outcome.rowsCount}`);
				await paused('Download stopped', stalledMessage(outcome.rowsStored, outcome.rowsCount), '', true);
			}
		} catch (error) {
			const { message, detail } = describeDownloadError(error);
			log(`error: ${message} ${detail}`);
			await paused('Download interrupted', `${message} The count already on this device is unchanged.`, detail);
		} finally {
			keepScreenOn(false);
			cancelRef.current = false;
			if (mounted.current) setCancelling(false);
		}
	}

	/** InitPullTables, then the pages (§6.1 steps 3–6). Called after the D8 check. */
	async function begin(countNumber: string) {
		const machineCheck = checkMachineName(getMachineName());
		if (!machineCheck.ok) {
			await Dialogs.alert({ title: 'Machine name', message: 'Set this device\'s machine name in Settings first.', okButtonText: 'OK' });
			return setPhase({ kind: 'enter' });
		}
		cancelRef.current = false;
		cancelTappedAt.current = null;
		const t0 = Date.now();
		setStartedAt(t0);
		setPhase({ kind: 'contacting', countNumber });
		keepScreenOn(true);
		log(`start count ${countNumber} at ${location} / ${machineCheck.value}`);
		let result;
		try {
			result = await startNewDownload(db, client(), { location, machine: machineCheck.value, countNumber, deviceInfo: deviceInfoText() });
		} catch (error) {
			keepScreenOn(false);
			const { message, detail } = describeDownloadError(error);
			return setPhase({ kind: 'startFailed', countNumber, title: 'Download not started', message, detail });
		}
		log(`InitPullTables answered after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${result.kind}`);
		if (result.kind === 'notDownloadable') {
			keepScreenOn(false);
			if (result.reason === 'noLines') {
				return setPhase({ kind: 'startFailed', countNumber, title: 'Nothing to download', message: noLinesMessage(countNumber, location), detail: '' });
			}
			if (result.reason === 'incomplete') {
				const seconds = Math.round((Date.now() - t0) / 1000);
				return setPhase({ kind: 'startFailed', countNumber, title: 'Download not started', message: incompleteMessage(countNumber, seconds), detail: '' });
			}
			return setPhase({ kind: 'notDownloadable', countNumber, machine: machineCheck.value });
		}
		if (result.kind === 'noResults' || result.kind === 'failed') {
			keepScreenOn(false);
			const message = result.kind === 'noResults' ? result.message : result.failure.message;
			const detail = result.kind === 'failed' && 'detail' in result.failure ? result.failure.detail : '';
			return setPhase({ kind: 'startFailed', countNumber, title: 'Download not started', message, detail });
		}
		if (cancelRef.current) {
			keepScreenOn(false);
			cancelRef.current = false;
			setCancelling(false);
			return paused('Download cancelled', 'The download was cancelled. The count already on this device is unchanged.', '');
		}
		await runPages(countNumber, t0);
	}

	/** D8 (§6.1 step 1): before anything is called, warn about counted lines not uploaded. */
	async function checkThenBegin(countNumber: string) {
		const pending = await db.pendingCount();
		if (pending > 0) return setPhase({ kind: 'd8', countNumber, pending });
		await begin(countNumber);
	}

	const onDownload = () => {
		const check = checkCountNumber(countText);
		if (!check.ok) return;
		void checkThenBegin(check.value);
	};

	const onContinue = (countNumber: string) => {
		cancelRef.current = false;
		cancelTappedAt.current = null;
		const t0 = Date.now();
		setStartedAt(t0);
		log(`continue count ${countNumber}`);
		void runPages(countNumber, t0);
	};

	const onAbandon = async () => {
		const ok = await Dialogs.confirm({
			title: 'Abandon download',
			message: 'The partly downloaded count is removed from this device. The count already on this device stays as it is.',
			okButtonText: 'Abandon download',
			cancelButtonText: 'Keep it',
		});
		if (!ok) return;
		await db.abandonDownload();
		setPhase({ kind: 'enter' });
	};

	const elapsed = startedAt ? formatElapsed(now - startedAt) : '0:00';
	const countCheck = checkCountNumber(countText);
	const note = machineChangeNote(machine, sheetMachine, location);

	let body: React.ReactNode = null;
	switch (phase.kind) {
		case 'loading':
			body = <label className="hint" text="…" />;
			break;

		case 'enter':
			body = (
				<stackLayout>
					<label className="field-label" text="Physical count number" />
					<textField
						className={countText !== '' && !countCheck.ok ? 'invalid' : ''}
						text={countText}
						hint="e.g. 1234"
						keyboardType="integer"
						maxLength={18}
						returnKeyType="go"
						onTextChange={(args: PropertyChangeData) => setCountText(String(args.value ?? ''))}
						onReturnPress={onDownload}
					/>
					{countText !== '' && !countCheck.ok && <label className="error" textWrap={true} text={countCheck.message} />}
					<label className="hint" textWrap={true} text={`Location ${location} · server ${profile.serverAddress} · machine ${machine || '(not set)'}`} />
					{note && <label className="warning" textWrap={true} text={note} />}
					{!machine && <label className="warning" textWrap={true} text="Set this device's machine name in Settings before downloading." />}
					<button text="Download" isEnabled={countCheck.ok && !!machine} onTap={onDownload} />
				</stackLayout>
			);
			break;

		case 'd8':
			body = (
				<stackLayout className="card">
					<label className="card-title" text="Counts not uploaded" />
					<label className="warning" textWrap={true} text={d8Message(phase.pending)} />
					<button text="Upload first" onTap={() => navigate({ type: 'push', route: { name: 'upload' } })} />
					<button className="btn-danger" text={discardButtonText(phase.pending)} onTap={() => void begin(phase.countNumber)} />
					<button className="btn-secondary" text="Cancel" onTap={() => setPhase({ kind: 'enter' })} />
				</stackLayout>
			);
			break;

		case 'contacting':
			body = (
				<stackLayout>
					<label className="card-title" text={`Count ${phase.countNumber}`} />
					<activityIndicator busy={true} />
					<label className="hint" textWrap={true} text="Preparing the count on the server…" />
					<label className="field-value" text={`Elapsed ${elapsed}`} />
					<button className="btn-danger" text={cancelling ? 'Cancelling…' : 'Cancel'} isEnabled={!cancelling} onTap={requestCancel} />
				</stackLayout>
			);
			break;

		case 'paging':
			body = (
				<stackLayout>
					<label className="card-title" text={`Count ${phase.countNumber}`} />
					<ProgressList tables={phase.tables} />
					<label className="field-value" text={`Elapsed ${elapsed}`} />
					{cancelling && <label className="warning" textWrap={true} text="Cancelling after the current page…" />}
					<button className="btn-danger" text={cancelling ? 'Cancelling…' : 'Cancel'} isEnabled={!cancelling} onTap={requestCancel} />
				</stackLayout>
			);
			break;

		case 'paused':
			body = (
				<stackLayout>
					<label className="card-title" textWrap={true} text={phase.title} />
					<label className={phase.detail || phase.stalled ? 'error' : 'warning'} textWrap={true} text={phase.message} />
					{phase.detail !== '' && <label className="hint" textWrap={true} text={phase.detail} />}
					<ProgressList tables={phase.tables} />
					<label className="hint" textWrap={true} text="Scan, Items and Upload stay locked until the download is finished or abandoned." />
					{!phase.stalled && <button text="Continue download" onTap={() => onContinue(phase.countNumber)} />}
					<button className={phase.stalled ? '' : 'btn-secondary'} text="Restart download" onTap={() => void checkThenBegin(phase.countNumber)} />
					<button className="btn-danger" text="Abandon download" onTap={() => void onAbandon()} />
				</stackLayout>
			);
			break;

		case 'startFailed':
			body = (
				<stackLayout>
					<label className="card-title" textWrap={true} text={phase.title} />
					<label className="error" textWrap={true} text={phase.message} />
					{phase.detail !== '' && <label className="hint" textWrap={true} text={phase.detail} />}
					<label className="hint" textWrap={true} text="Nothing on this device has changed." />
					<button text="Try again" onTap={() => void begin(phase.countNumber)} />
					<button className="btn-secondary" text="Change count number" onTap={() => setPhase({ kind: 'enter' })} />
				</stackLayout>
			);
			break;

		case 'notDownloadable':
			body = (
				<stackLayout>
					<label className="error" textWrap={true} text={NOT_DOWNLOADABLE_TITLE} />
					<label className="hint" textWrap={true} text="Likely causes:" />
					{notDownloadableCauses(phase.countNumber, location, phase.machine).map((cause) => (
						<label key={cause} className="hint" textWrap={true} text={`• ${cause}`} />
					))}
					<label className="hint" textWrap={true} text="Nothing on this device has changed." />
					<button className="btn-secondary" text="Change count number" onTap={() => setPhase({ kind: 'enter' })} />
				</stackLayout>
			);
			break;

		case 'done': {
			const s = phase.summary;
			body = (
				<stackLayout>
					<label className="ok" text="Download complete" />
					<stackLayout className="card">
						<label className="field-label" text="Count number" />
						<label className="field-value" text={s.countNumber} />
						<label className="field-label" text="Warehouse" />
						<label className="field-value" text={s.warehouse || '—'} />
						<label className="field-label" text="Date" />
						<label className="field-value" text={s.date || '—'} />
						<label className="field-label" text="Lines / barcodes" />
						<label className="field-value" text={`${s.lines} lines, ${s.barcodes} barcodes`} />
						<label className="field-label" text="Time taken" />
						<label className="field-value" text={formatElapsed(s.elapsedMs)} />
					</stackLayout>
					{s.lines > 0 && s.barcodes === 0 && <label className="warning" textWrap={true} text={NO_BARCODES_NOTE} />}
					<button text="Done" onTap={() => navigate({ type: 'reset' })} />
				</stackLayout>
			);
			break;
		}
	}

	return (
		<gridLayout rows="auto, *">
			<Header title="Download" />
			<scrollView row={1}>
				<stackLayout className="content">{body}</stackLayout>
			</scrollView>
		</gridLayout>
	);
}
