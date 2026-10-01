import { Dialogs } from '@nativescript/core';
import * as React from 'react';
import { formatElapsed } from '../domain/downloadText';
import { DOWNLOAD_RUNNING_TEXT, NO_SHEET_TEXT } from '../domain/itemText';
import { confirmText, NO_COUNTED_ITEMS, pendingText, rowText, sentText } from '../domain/uploadText';
import { keepScreenOn } from '../platform/keepScreenOn';
import { SoapClient } from '../soap/client';
import { httpTransport } from '../soap/httpTransport';
import { runUpload, UploadHeader, UploadOutcome } from '../storage/upload';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';

declare const require: any;

/**
 * Upload (REBUILD_PLAN §2.1, §6.2): confirmation, then one InsertDetail per counted
 * line with "Row x / N", elapsed time and Cancel, then the result. The loop itself is
 * storage/upload.ts; this screen only starts it, shows it and keeps the screen on.
 */

type Phase =
	| { kind: 'loading' }
	/** No sheet, or a download in progress (§5.1). */
	| { kind: 'blocked'; message: string }
	| { kind: 'none' }
	| { kind: 'confirm'; pending: number; header: UploadHeader; countNumber: string }
	| { kind: 'running'; row: number; total: number }
	| { kind: 'result'; outcome: UploadOutcome; pending: number; elapsedMs: number }
	/** Something failed on this device (the database), not on the server. */
	| { kind: 'failed'; message: string };

const log = (message: string) => console.log(`[upload] ${message}`);

const RESULT_TITLE: Record<UploadOutcome['kind'], string> = { completed: 'Upload complete', cancelled: 'Upload cancelled', stopped: 'Upload stopped' };

export function UploadScreen() {
	const { profile, locationDb, navigate, setBackGuard } = useApp();
	const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });
	const [startedAt, setStartedAt] = React.useState<number | null>(null);
	const [now, setNow] = React.useState(Date.now());
	const [cancelling, setCancelling] = React.useState(false);
	const cancelRef = React.useRef(false);
	const mounted = React.useRef(true);
	const running = phase.kind === 'running';

	// Upload needs a complete sheet and no download in progress (§5.1); then the number of counted lines.
	React.useEffect(() => {
		mounted.current = true;
		(async () => {
			if (!profile || !locationDb) return;
			try {
				const [sheet, inProgress, pending] = await Promise.all([locationDb.sheetInfo(), locationDb.isDownloadInProgress(), locationDb.pendingCount()]);
				if (!mounted.current) return;
				if (inProgress) return setPhase({ kind: 'blocked', message: DOWNLOAD_RUNNING_TEXT });
				if (!sheet) return setPhase({ kind: 'blocked', message: NO_SHEET_TEXT });
				if (pending === 0) return setPhase({ kind: 'none' });
				setPhase({ kind: 'confirm', pending, countNumber: sheet.countNumber, header: { location: profile.location, invId: sheet.invId, userToUpdate: sheet.userToUpdate } });
			} catch (error) {
				if (mounted.current) setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
			}
		})();
		return () => {
			mounted.current = false;
			keepScreenOn(false);
		};
	}, [profile, locationDb]);

	// Elapsed time ticks while running.
	React.useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [running]);

	// Back during a running upload asks first.
	React.useEffect(() => {
		if (!running) {
			setBackGuard(null);
			return;
		}
		setBackGuard(async () => {
			const ok = await Dialogs.confirm({ title: 'Upload', message: 'Cancel the upload?', okButtonText: 'Cancel upload', cancelButtonText: 'Keep uploading' });
			if (ok) requestCancel();
			return false;
		});
		return () => setBackGuard(null);
	}, [running]);

	if (!profile || !locationDb) {
		return (
			<gridLayout rows="auto, *">
				<Header title="Upload" />
				<label row={1} className="content warning" textWrap={true} text="Select a location in Settings first." />
			</gridLayout>
		);
	}
	const db = locationDb;
	const serverAddress = profile.serverAddress;

	function requestCancel() {
		if (cancelRef.current) return;
		cancelRef.current = true;
		setCancelling(true);
		log('Cancel tapped');
	}

	async function upload(pending: number, header: UploadHeader) {
		cancelRef.current = false;
		setCancelling(false);
		const t0 = Date.now();
		setStartedAt(t0);
		setNow(t0);
		setPhase({ kind: 'running', row: 1, total: pending });
		keepScreenOn(true);
		log(`start: ${pending} lines, count ${header.invId} at ${header.location}, slot ${header.userToUpdate}`);
		try {
			const outcome = await runUpload(db, new SoapClient(serverAddress, httpTransport), header, {
				shouldCancel: () => cancelRef.current,
				onProgress: (p) => {
					log(`row ${p.row} / ${p.total}: line ${p.pcdRecId}`);
					if (mounted.current) setPhase({ kind: 'running', row: p.row, total: p.total });
				},
				log,
				delayBeforeLineMs: __DEBUG_TOOLS__ ? require('../debug/uploadDelay').getUploadDelayMs() : 0,
			});
			const left = await db.pendingCount();
			const elapsedMs = Date.now() - t0;
			log(`${outcome.kind}: ${outcome.sent} of ${outcome.total} sent, ${left} pending, ${(elapsedMs / 1000).toFixed(1)} s${outcome.stop ? `; stopped at line ${outcome.stop.pcdRecId}: ${outcome.stop.title}` : ''}`);
			if (mounted.current) setPhase({ kind: 'result', outcome, pending: left, elapsedMs });
		} catch (error) {
			log(`error: ${String(error)}`);
			if (mounted.current) setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
		} finally {
			keepScreenOn(false);
			cancelRef.current = false;
			if (mounted.current) setCancelling(false);
		}
	}

	const home = <button text="Home" onTap={() => navigate({ type: 'reset' })} />;
	const elapsed = startedAt ? formatElapsed(now - startedAt) : '0:00';

	let body: React.ReactNode = null;
	switch (phase.kind) {
		case 'loading':
			body = <label className="hint" text="…" />;
			break;

		case 'blocked':
			body = (
				<stackLayout>
					<label className="warning" textWrap={true} text={phase.message} />
					{home}
				</stackLayout>
			);
			break;

		case 'none':
			body = (
				<stackLayout>
					<label className="card-title" textWrap={true} text={NO_COUNTED_ITEMS} />
					<label className="hint" textWrap={true} text="Lines appear here for upload after they are counted in Scan." />
					{home}
				</stackLayout>
			);
			break;

		case 'confirm':
			body = (
				<stackLayout>
					<label className="card-title" textWrap={true} text={confirmText(phase.pending)} />
					<label className="hint" textWrap={true} text={`Count ${phase.countNumber} · location ${phase.header.location} · server ${serverAddress}`} />
					<button text="Upload" onTap={() => void upload(phase.pending, phase.header)} />
					<button className="btn-secondary" text="Cancel" onTap={() => navigate({ type: 'pop' })} />
				</stackLayout>
			);
			break;

		case 'running':
			body = (
				<stackLayout>
					<label className="card-title" text={rowText(phase.row, phase.total)} />
					<progress className="progress" value={Math.max(0, phase.row - 1)} maxValue={phase.total} />
					<label className="field-value" text={`Elapsed ${elapsed}`} />
					{cancelling && <label className="warning" textWrap={true} text="Cancelling after the current line…" />}
					<button className="btn-danger" text={cancelling ? 'Cancelling…' : 'Cancel'} isEnabled={!cancelling} onTap={requestCancel} />
				</stackLayout>
			);
			break;

		case 'result': {
			const { outcome } = phase;
			const stop = outcome.stop;
			body = (
				<stackLayout>
					<label className={outcome.kind === 'completed' ? 'ok' : outcome.kind === 'cancelled' ? 'warning' : 'error'} textWrap={true} text={RESULT_TITLE[outcome.kind]} />
					<stackLayout className="card">
						<label className="field-label" text="Lines sent" />
						<label className="field-value" textWrap={true} text={sentText(outcome.sent)} />
						<label className="field-label" text="Still pending" />
						<label className="field-value" textWrap={true} text={pendingText(phase.pending)} />
						<label className="field-label" text="Time taken" />
						<label className="field-value" text={formatElapsed(phase.elapsedMs)} />
					</stackLayout>
					{outcome.kind === 'cancelled' && <label className="hint" textWrap={true} text="The upload was cancelled. Lines not sent stay counted on this device and go with the next upload." />}
					{stop && (
						<stackLayout className="card">
							<label className="card-title" textWrap={true} text={stop.title} />
							{stop.pcdRecId !== null && <label className="field-value" textWrap={true} text={`Failed line: ${stop.pcdRecId}${stop.reference ? `   ·   ${stop.reference}` : ''}`} />}
							<label className="error" textWrap={true} text={stop.message} />
							{stop.detail !== '' && <label className="hint" textWrap={true} text={stop.detail} />}
						</stackLayout>
					)}
					{home}
				</stackLayout>
			);
			break;
		}

		case 'failed':
			body = (
				<stackLayout>
					<label className="card-title" text="Upload stopped" />
					<label className="error" textWrap={true} text={`An error on this device stopped the upload: ${phase.message}`} />
					<label className="hint" textWrap={true} text="Lines already sent are marked uploaded; the rest are still counted on this device." />
					{home}
				</stackLayout>
			);
			break;
	}

	return (
		<gridLayout rows="auto, *">
			<Header title="Upload" />
			<scrollView row={1}>
				<stackLayout className="content">{body}</stackLayout>
			</scrollView>
		</gridLayout>
	);
}
