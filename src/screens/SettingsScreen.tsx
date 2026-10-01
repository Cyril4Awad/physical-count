import { Dialogs, PropertyChangeData } from '@nativescript/core';
import * as React from 'react';
import type { Check } from '../domain/check';
import { checkLocationCode, checkMachineName, checkPageSize, checkServerAddress } from '../domain/validation';
import { testConnection } from '../soap/connectionTest';
import { httpGet } from '../soap/httpTransport';
import { getMachineName, getPageSize, getScannerInput, setMachineName, setPageSize, setScannerInput } from '../storage/deviceSettings';
import { SheetLockedError } from '../storage/locationDb';
import type { Profile } from '../storage/settingsDb';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';

declare const require: any;

/**
 * Settings (REBUILD_PLAN §2.2): location profiles, device settings (machine
 * name, download page size), Restore uploaded and Advanced (scanner input, §9.3).
 * Every field is checked on each keystroke (§3.7) and again on save.
 */

interface Editor {
	id: number | null;
	location: string;
	server: string;
	select: boolean;
	error: string | null;
}

interface SheetState {
	hasSheet: boolean;
	countNumber: string;
	sheetMachine: string;
	uploaded: number;
	downloadInProgress: boolean;
}

const valueOf = (args: PropertyChangeData) => String(args.value ?? '');
const messageOf = (check: Check<unknown>, touched: boolean) => (!touched || check.ok ? null : check.message);

function ErrorText({ text }: { text: string | null }) {
	return text ? <label className="error" textWrap={true} text={text} /> : null;
}

export function SettingsScreen() {
	const { settings, profile, locationDb, reloadProfile, navigate } = useApp();
	const [profiles, setProfiles] = React.useState<Profile[]>([]);
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const [connection, setConnection] = React.useState<Record<string, { ok: boolean; text: string }>>({});
	const [machine, setMachine] = React.useState(getMachineName());
	const [pageSize, setPageSizeText] = React.useState(String(getPageSize()));
	const [deviceTouched, setDeviceTouched] = React.useState(false);
	const [deviceMessage, setDeviceMessage] = React.useState<string | null>(null);
	const [sheet, setSheet] = React.useState<SheetState | null>(null);
	const [scannerInput, setScannerInputState] = React.useState(getScannerInput());

	const loadProfiles = React.useCallback(async () => setProfiles(await settings.listProfiles()), [settings]);

	const loadSheet = React.useCallback(async () => {
		if (!locationDb) return setSheet(null);
		const [info, counters, downloadInProgress] = await Promise.all([locationDb.sheetInfo(), locationDb.counters(), locationDb.isDownloadInProgress()]);
		setSheet({ hasSheet: !!info, countNumber: info?.countNumber ?? '', sheetMachine: info?.machineName ?? '', uploaded: counters.uploaded, downloadInProgress });
	}, [locationDb]);

	React.useEffect(() => {
		void loadProfiles();
	}, [loadProfiles]);
	React.useEffect(() => {
		void loadSheet();
	}, [loadSheet]);

	async function guarded(action: () => Promise<void>) {
		try {
			await action();
		} catch (error) {
			await Dialogs.alert({ title: 'Error', message: error instanceof Error ? error.message : String(error), okButtonText: 'OK' });
		}
	}

	// ── Profiles ──────────────────────────────────────────────────────────

	const select = (p: Profile) =>
		guarded(async () => {
			if (p.selected) return;
			const result = await settings.selectProfile(p.id);
			if (!result.ok) throw new Error(result.message);
			await reloadProfile();
			await loadProfiles();
		});

	const saveEditor = () =>
		guarded(async () => {
			if (!editor) return;
			const location = checkLocationCode(editor.location);
			const server = checkServerAddress(editor.server);
			if (!location.ok || !server.ok) return setEditor({ ...editor, error: !location.ok ? location.message : !server.ok ? server.message : null });
			const result = editor.id === null ? await settings.addProfile(editor.location, editor.server, { select: editor.select }) : await settings.editProfile(editor.id, editor.location, editor.server);
			if (!result.ok) return setEditor({ ...editor, error: result.message });
			setEditor(null);
			await reloadProfile();
			await loadProfiles();
		});

	const remove = (p: Profile) =>
		guarded(async () => {
			const warning = await settings.deleteWarning(p.id);
			if (!warning) return loadProfiles();
			const pending = warning.pendingCount;
			const message =
				(pending > 0
					? `${pending} counted line${pending === 1 ? ' has' : 's have'} not been uploaded at ${p.location}.\n\nThey stay on this device in the location's database and come back if you add ${p.location} again.\n\n`
					: `The location's database stays on this device.\n\n`) + `Delete the profile for ${p.location}?`;
			const ok = await Dialogs.confirm({ title: pending > 0 ? 'Counts not uploaded' : 'Delete profile', message, okButtonText: 'Delete profile', cancelButtonText: 'Cancel' });
			if (!ok) return;
			await settings.deleteProfile(p.id);
			if (p.selected) await reloadProfile();
			await loadProfiles();
		});

	const test = (key: string, address: string) =>
		guarded(async () => {
			setConnection((c) => ({ ...c, [key]: { ok: true, text: 'Testing…' } }));
			const result = await testConnection(address, httpGet);
			setConnection((c) => ({ ...c, [key]: { ok: result.reachable, text: result.reachable ? result.message : `${result.message} ${result.detail}` } }));
		});

	// ── Device settings ───────────────────────────────────────────────────

	const machineCheck = checkMachineName(machine);
	const pageSizeCheck = checkPageSize(pageSize);

	const saveDevice = () =>
		guarded(async () => {
			setDeviceTouched(true);
			if (!machineCheck.ok || !pageSizeCheck.ok) return setDeviceMessage(null);
			const previous = getMachineName();
			// Warn only when the new name differs from the one the current sheet (or download) belongs to.
			const sheetOwner = sheet?.sheetMachine || previous;
			if (previous && machineCheck.value !== previous && machineCheck.value !== sheetOwner && sheet && (sheet.hasSheet || sheet.downloadInProgress)) {
				const what = sheet.downloadInProgress
					? `A download for ${profile?.location} was started with machine name ${previous}.`
					: `The count at ${profile?.location} (count ${sheet.countNumber}) was downloaded for machine ${sheet.sheetMachine || previous}; its counts upload to that machine's column.`;
				const ok = await Dialogs.confirm({
					title: 'Change the machine name?',
					message: `${what}\n\nThe new name ${machineCheck.value} is used from the next download. It must be one of the machine users of the count in the ERP.`,
					okButtonText: 'Change it',
					cancelButtonText: 'Cancel',
				});
				if (!ok) return;
			}
			const savedName = setMachineName(machine);
			const savedSize = setPageSize(pageSize);
			setDeviceMessage(savedName.ok && savedSize.ok ? 'Saved.' : null);
		});

	const restoreUploaded = () =>
		guarded(async () => {
			if (!locationDb || !sheet) return;
			if (sheet.uploaded === 0) {
				await Dialogs.alert({ title: 'Restore uploaded', message: 'No uploaded lines to restore.', okButtonText: 'OK' });
				return;
			}
			const ok = await Dialogs.confirm({
				title: 'Restore uploaded',
				message: `${sheet.uploaded} uploaded line${sheet.uploaded === 1 ? '' : 's'} will be sent again at the next upload. The server keeps the last value sent, so this is safe.`,
				okButtonText: 'Restore',
				cancelButtonText: 'Cancel',
			});
			if (!ok) return;
			try {
				const n = await locationDb.restoreUploaded();
				await Dialogs.alert({ title: 'Restore uploaded', message: `${n} line${n === 1 ? '' : 's'} will be sent again.`, okButtonText: 'OK' });
			} catch (error) {
				if (error instanceof SheetLockedError) throw new Error('A download is in progress; finish or abandon it first.');
				throw error;
			}
			await loadSheet();
		});

	// ── Render ────────────────────────────────────────────────────────────

	const editorLocation = editor ? checkLocationCode(editor.location) : null;
	const editorServer = editor ? checkServerAddress(editor.server) : null;

	return (
		<gridLayout rows="auto, *">
			<Header title="Settings" />
			<scrollView row={1}>
				<stackLayout className="content">
					<label className="section-title" text="Location profiles" />
					<label className="hint" textWrap={true} text="Tap a profile to use that location. Each location keeps its own downloaded count on this device." />

					{profiles.map((p) => (
						<stackLayout key={p.id} className={p.selected ? 'profile selected' : 'profile'} onTap={() => select(p)}>
							<gridLayout columns="*, auto">
								<label col={0} className="profile-loc" text={p.location} />
								<label col={1} className="profile-mark" text={p.selected ? '● IN USE' : 'Tap to use'} />
							</gridLayout>
							<label className="profile-server" text={p.serverAddress} />
							{connection[`p${p.id}`] && <label className={connection[`p${p.id}`].ok ? 'ok' : 'error'} textWrap={true} text={connection[`p${p.id}`].text} />}
							<flexboxLayout flexWrap="wrap" marginTop={8}>
								<button className="btn-secondary btn-small" text="Test connection" onTap={() => test(`p${p.id}`, p.serverAddress)} />
								<button
									className="btn-secondary btn-small"
									text="Edit"
									onTap={() => setEditor({ id: p.id, location: p.location, server: p.serverAddress, select: false, error: null })}
								/>
								<button className="btn-danger btn-small" text="Delete" onTap={() => remove(p)} />
							</flexboxLayout>
						</stackLayout>
					))}
					{profiles.length === 0 && <label className="warning" textWrap={true} text="No profiles yet. Add one for this location." />}

					{editor ? (
						<stackLayout className="card">
							<label className="card-title" text={editor.id === null ? 'New profile' : 'Edit profile'} />
							<label className="field-label" textWrap={true} text="Location code (1–2 letters or digits, as in the ERP)" />
							<textField
								className={editorLocation && !editorLocation.ok && editor.location !== '' ? 'invalid' : ''}
								text={editor.location}
								hint="e.g. V2"
								maxLength={2}
								autocorrect={false}
								autocapitalizationType="none"
								onTextChange={(args: PropertyChangeData) => setEditor((e) => e && { ...e, location: valueOf(args), error: null })}
							/>
							<ErrorText text={editorLocation && editor.location !== '' ? messageOf(editorLocation, true) : null} />
							<label className="field-label" textWrap={true} text="Server (name or address, optional :port, no http://)" />
							<textField
								className={editorServer && !editorServer.ok && editor.server !== '' ? 'invalid' : ''}
								text={editor.server}
								hint="e.g. 192.168.1.10"
								keyboardType="url"
								autocorrect={false}
								autocapitalizationType="none"
								onTextChange={(args: PropertyChangeData) => setEditor((e) => e && { ...e, server: valueOf(args), error: null })}
							/>
							<ErrorText text={editorServer && editor.server !== '' ? messageOf(editorServer, true) : null} />
							{connection.editor && <label className={connection.editor.ok ? 'ok' : 'error'} textWrap={true} text={connection.editor.text} />}
							{editor.id === null && (
								<gridLayout columns="*, auto" marginBottom={8}>
									<label col={0} className="field-value" verticalAlignment="middle" text="Use this location now" />
									<switch col={1} checked={editor.select} onCheckedChange={(args: PropertyChangeData) => setEditor((e) => e && { ...e, select: !!args.value })} />
								</gridLayout>
							)}
							<ErrorText text={editor.error} />
							<button className="btn-secondary" text="Test connection" isEnabled={!!editorServer?.ok} onTap={() => test('editor', editor.server)} />
							<button text="Save profile" onTap={saveEditor} />
							<button className="btn-secondary" text="Cancel" onTap={() => setEditor(null)} />
						</stackLayout>
					) : (
						<button className="btn-secondary" text="Add profile" onTap={() => setEditor({ id: null, location: '', server: '', select: profiles.length === 0, error: null })} />
					)}

					<label className="section-title" text="This device" />
					<label className="field-label" textWrap={true} text="Machine name (as assigned in the ERP count, 1–5 letters or digits)" />
					<textField
						className={deviceTouched && !machineCheck.ok ? 'invalid' : ''}
						text={machine}
						hint="e.g. UN3"
						maxLength={5}
						autocorrect={false}
						autocapitalizationType="none"
						onTextChange={(args: PropertyChangeData) => {
							setMachine(valueOf(args));
							setDeviceTouched(true);
							setDeviceMessage(null);
						}}
					/>
					<ErrorText text={messageOf(machineCheck, deviceTouched)} />
					<label className="field-label" textWrap={true} text="Download page size (rows per request, 1–5000)" />
					<textField
						className={deviceTouched && !pageSizeCheck.ok ? 'invalid' : ''}
						text={pageSize}
						keyboardType="integer"
						maxLength={4}
						onTextChange={(args: PropertyChangeData) => {
							setPageSizeText(valueOf(args));
							setDeviceTouched(true);
							setDeviceMessage(null);
						}}
					/>
					<ErrorText text={messageOf(pageSizeCheck, deviceTouched)} />
					{deviceMessage && <label className="ok" text={deviceMessage} />}
					<button text="Save device settings" onTap={saveDevice} />

					<label className="section-title" text="Uploaded lines" />
					<label
						className="hint"
						textWrap={true}
						text={
							!profile
								? 'Select a location first.'
								: !sheet?.hasSheet
									? `No count downloaded at ${profile.location}.`
									: `${sheet.uploaded} line${sheet.uploaded === 1 ? '' : 's'} uploaded at ${profile.location} (count ${sheet.countNumber}). Restore uploaded marks them to be sent again.`
						}
					/>
					<button className="btn-secondary" text="Restore uploaded" isEnabled={!!sheet?.hasSheet && !sheet.downloadInProgress} onTap={restoreUploaded} />

					<label className="section-title" text="Advanced" />
					<gridLayout columns="*, auto">
						<stackLayout col={0}>
							<label className="field-label" text="Scanner input" />
							<label className="field-value" text={scannerInput === 'textInput' ? 'Text input' : 'Key events'} />
						</stackLayout>
						<switch
							col={1}
							verticalAlignment="middle"
							checked={scannerInput === 'textInput'}
							onCheckedChange={(args: PropertyChangeData) => {
								const mode = args.value ? 'textInput' : 'keyEvents';
								setScannerInput(mode);
								setScannerInputState(mode);
							}}
						/>
					</gridLayout>
					<label
						className="hint"
						textWrap={true}
						text="Key events is the normal setting. Switch to Text input only if scans type nothing into the Scan screen. It is used the next time Scan opens."
					/>

					{__DEBUG_TOOLS__ && React.createElement(require('../debug/DebugTools').DebugTools, {
							locationDb,
							onChanged: loadSheet,
							openScanLine: (id: string) => navigate({ type: 'push', route: { name: 'scan', lineId: id } }),
						})}
				</stackLayout>
			</scrollView>
		</gridLayout>
	);
}
