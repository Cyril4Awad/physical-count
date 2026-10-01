import * as React from 'react';
import { lastUploadText } from '../domain/uploadText';
import { getMachineName } from '../storage/deviceSettings';
import type { SheetCounters, SheetInfo } from '../storage/locationDb';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';

/**
 * Home (REBUILD_PLAN §2.1): header card, three counters, five buttons.
 * Scan, Items and Upload need a complete sheet and no download in progress (§5.1).
 * With no profile selected, only Settings and a hint are shown.
 */

interface HomeData {
	sheet: SheetInfo | null;
	counters: SheetCounters;
	downloadInProgress: boolean;
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<stackLayout>
			<label className="field-label" text={label} />
			<label className="field-value" text={value || '—'} textWrap={true} />
		</stackLayout>
	);
}

function Counter({ col, value, label }: { col: number; value: number | string; label: string }) {
	return (
		<stackLayout col={col} className="counter">
			<label className="counter-value" text={String(value)} />
			<label className="counter-label" text={label} textWrap={true} />
		</stackLayout>
	);
}

export function HomeScreen() {
	const { profile, locationDb, navigate } = useApp();
	const [data, setData] = React.useState<HomeData | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const machineName = getMachineName();

	React.useEffect(() => {
		let active = true;
		setData(null);
		if (!locationDb) return;
		(async () => {
			try {
				const [sheet, counters, downloadInProgress] = await Promise.all([locationDb.sheetInfo(), locationDb.counters(), locationDb.isDownloadInProgress()]);
				if (active) setData({ sheet, counters, downloadInProgress });
			} catch (e) {
				if (active) setError(String(e));
			}
		})();
		return () => {
			active = false;
		};
	}, [locationDb]);

	if (!profile) {
		return (
			<gridLayout rows="auto, *">
				<Header title="Physical Count" />
				<scrollView row={1}>
					<stackLayout className="content">
						<stackLayout className="card">
							<label className="card-title" text="No location selected" />
							<label
								className="hint"
								textWrap={true}
								text="Open Settings, add a profile for this location (location code and server address) and select it. Also type this device's machine name."
							/>
						</stackLayout>
						<button text="Settings" onTap={() => navigate({ type: 'push', route: { name: 'settings' } })} />
					</stackLayout>
				</scrollView>
			</gridLayout>
		);
	}

	const sheetReady = !!data?.sheet && !data.downloadInProgress;
	const counters = data?.counters;
	const show = (n: number | undefined) => (n === undefined ? '…' : n);
	const lastUpload = data?.sheet ? lastUploadText(data.sheet.lastUploadAt, data.sheet.lastUploadLines) : null;

	return (
		<gridLayout rows="auto, *">
			<Header title="Physical Count" />
			<scrollView row={1}>
				<stackLayout className="content">
					<gridLayout className="card" columns="*, *" rows="auto, auto, auto">
						<stackLayout row={0} col={0}>
							<Field label="Location" value={profile.location} />
						</stackLayout>
						<stackLayout row={0} col={1}>
							<Field label="Server" value={profile.serverAddress} />
						</stackLayout>
						<stackLayout row={1} col={0}>
							{/* The sheet's machine name decides the upload slot; without a sheet, the Settings name is the one the next download uses. */}
							<Field label="Machine" value={data?.sheet?.machineName || machineName || 'not set'} />
						</stackLayout>
						<stackLayout row={1} col={1}>
							<Field label="Count number" value={data?.sheet?.countNumber ?? (data ? 'none' : '…')} />
						</stackLayout>
						<stackLayout row={2} col={0}>
							<Field label="Warehouse" value={data?.sheet?.warehouse ?? ''} />
						</stackLayout>
						<stackLayout row={2} col={1}>
							<Field label="Date" value={data?.sheet?.dateCount ?? ''} />
						</stackLayout>
					</gridLayout>

					{!machineName && <label className="warning" textWrap={true} text="No machine name yet: set it in Settings before downloading." />}
					{data?.downloadInProgress && (
						<label className="warning" textWrap={true} text="A download is in progress. Continue or abandon it in Download; counting is locked until then." />
					)}
					{data && !data.sheet && !data.downloadInProgress && <label className="hint" textWrap={true} text="No count downloaded for this location yet." />}
					{error && <label className="error" textWrap={true} text={error} />}

					<gridLayout columns="*, *, *" rows="auto">
						<Counter col={0} value={show(counters?.notCounted)} label="Not counted" />
						<Counter col={1} value={show(counters?.pending)} label="Counted, not uploaded" />
						<Counter col={2} value={show(counters?.uploaded)} label="Uploaded" />
					</gridLayout>

					{lastUpload && <label className="hint" textWrap={true} text={`Last upload: ${lastUpload}`} />}

					<button text="Scan" isEnabled={sheetReady} onTap={() => navigate({ type: 'push', route: { name: 'scan' } })} />
					<button text="Items" isEnabled={sheetReady} onTap={() => navigate({ type: 'push', route: { name: 'items', tab: 'notCounted' } })} />
					<button text="Download" onTap={() => navigate({ type: 'push', route: { name: 'download' } })} />
					<button text="Upload" isEnabled={sheetReady} onTap={() => navigate({ type: 'push', route: { name: 'upload' } })} />
					<button className="btn-secondary" text="Settings" onTap={() => navigate({ type: 'push', route: { name: 'settings' } })} />
				</stackLayout>
			</scrollView>
		</gridLayout>
	);
}
