import { ItemEventData, ListView } from '@nativescript/core';
import * as React from 'react';
import type { NSVElement } from 'react-nativescript';
import { DOWNLOAD_RUNNING_TEXT, emptyTabText, expiryShown, itemRowText, ItemsTab, NO_SHEET_TEXT, tabLabel } from '../domain/itemText';
import { PagedList } from '../domain/pagedList';
import { bindItemCell, createItemCell } from '../platform/itemCell';
import type { Line, SheetCounters } from '../storage/locationDb';
import { useApp } from '../shell/AppContext';
import { Header } from '../shell/Header';
import type { ListPosition } from '../shell/screenStack';

/**
 * Items (REBUILD_PLAN §2.1): two tabs, Counted (updated = '1') and Not counted ('0');
 * uploaded lines ('2') are not listed, as legacy. Each list is a native ListView over a
 * PagedList: rows are read from SQLite a page at a time as the list scrolls, and only a
 * few pages stay in memory. Tapping a row opens Scan in display mode for that line.
 */

const PAGE_SIZE = 100;
/** At most 600 lines in memory, whatever the size of the sheet. */
const MAX_PAGES = 6;
const TOP: ListPosition = { index: 0, offset: 0 };
const STATE: Record<ItemsTab, '0' | '1'> = { counted: '1', notCounted: '0' };
const log = (message: string) => console.log(`[items] ${message}`);

export function ItemsScreen({ tab: initialTab, position }: { tab: ItemsTab; position?: ListPosition }) {
	const { locationDb, navigate } = useApp();
	const [blocked, setBlocked] = React.useState<string | null>(null);
	const [counters, setCounters] = React.useState<SheetCounters | null>(null);
	const [showExpiry, setShowExpiry] = React.useState(true);
	const [tab, setTab] = React.useState<ItemsTab>(initialTab);
	const [error, setError] = React.useState<string | null>(null);

	const listRef = React.useRef<NSVElement<ListView>>(null);
	const openedAt = React.useRef(Date.now());
	const firstRowLogged = React.useRef(false);
	const refreshQueued = React.useRef(false);
	const bindStats = React.useRef({ rows: 0, ms: 0, placeholders: 0 });
	// Each tab keeps its own place while the screen is open; the route carries the active one across Scan.
	const positions = React.useRef<Record<ItemsTab, ListPosition>>({ counted: TOP, notCounted: TOP, [initialTab]: position ?? TOP });

	// Items needs a complete sheet and no download in progress (§5.1). Counters are read again on every open,
	// so the tab numbers and lists are current after returning from Scan.
	React.useEffect(() => {
		let active = true;
		(async () => {
			if (!locationDb) return setBlocked('Select a location in Settings first.');
			try {
				const [sheet, inProgress, numbers] = await Promise.all([locationDb.sheetInfo(), locationDb.isDownloadInProgress(), locationDb.counters()]);
				if (!active) return;
				if (inProgress) return setBlocked(DOWNLOAD_RUNNING_TEXT);
				if (!sheet) return setBlocked(NO_SHEET_TEXT);
				setShowExpiry(expiryShown(sheet.spExpiry));
				setCounters(numbers);
				log(`opened: counted ${numbers.pending}, not counted ${numbers.notCounted}, uploaded (hidden) ${numbers.uploaded}`);
			} catch (e) {
				if (active) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			active = false;
		};
	}, [locationDb]);

	const total = counters ? (tab === 'counted' ? counters.pending : counters.notCounted) : 0;

	/** Redraws the visible rows once, however many pages arrived in this tick. */
	const refreshList = React.useCallback(() => {
		if (refreshQueued.current) return;
		refreshQueued.current = true;
		setTimeout(() => {
			refreshQueued.current = false;
			listRef.current?.nativeView?.refresh();
		}, 0);
	}, []);

	const source = React.useMemo(() => {
		if (!locationDb || total === 0) return null;
		const list: PagedList<Line> = new PagedList<Line>({
			total,
			pageSize: PAGE_SIZE,
			maxPages: MAX_PAGES,
			loadPage: (offset, limit) => locationDb.listLines(STATE[tab], offset, limit),
			onPageLoaded: () => {
				if (__DEBUG_TOOLS__) log(`page loaded, ${list.loadedRows} of ${total} lines in memory`);
				refreshList();
			},
			onError: (e) => setError(e instanceof Error ? e.message : String(e)),
		});
		return list;
	}, [locationDb, tab, total, refreshList]);

	function readPosition(): ListPosition {
		const native = listRef.current?.nativeView?.android as android.widget.ListView | undefined;
		if (!native || native.getChildCount() === 0) return TOP;
		return { index: native.getFirstVisiblePosition(), offset: native.getChildAt(0).getTop() - native.getPaddingTop() };
	}

	// A new list (first open, tab switch): go back to where this tab was, then let the old list go.
	React.useEffect(() => {
		if (!source) return;
		const saved = positions.current[tab];
		const native = listRef.current?.nativeView?.android as android.widget.ListView | undefined;
		native?.setSelectionFromTop(Math.min(saved.index, source.length - 1), saved.offset);
		return () => source.dispose();
	}, [source]);

	if (blocked || !locationDb) {
		return (
			<gridLayout rows="auto, *">
				<Header title="Items" />
				<label row={1} className="content warning" textWrap={true} text={blocked ?? '…'} />
			</gridLayout>
		);
	}

	function switchTab(next: ItemsTab) {
		if (next === tab) return;
		positions.current[tab] = readPosition();
		setTab(next);
	}

	function onItemLoading(args: ItemEventData) {
		const started = __DEBUG_TOOLS__ ? Date.now() : 0;
		if (!args.view) args.view = createItemCell();
		const line = source?.getItem(args.index) ?? null;
		bindItemCell(args.view, line && itemRowText(line, tab, showExpiry), showExpiry);
		if (__DEBUG_TOOLS__) {
			// Scroll cost on this device: how long the app spends filling one row.
			const stats = bindStats.current;
			stats.ms += Date.now() - started;
			if (!line) stats.placeholders++;
			if (++stats.rows % 500 === 0) {
				log(`${stats.rows} rows filled, ${(stats.ms / stats.rows).toFixed(2)} ms each, ${stats.placeholders} shown as placeholders first`);
			}
		}
		if (line && !firstRowLogged.current) {
			firstRowLogged.current = true;
			log(`first row shown ${Date.now() - openedAt.current} ms after opening`);
		}
	}

	/** Display mode for that line (§5.3: no change). The route keeps the tab and place for Back. */
	function onItemTap(args: ItemEventData) {
		const line = source?.peek(args.index);
		if (!line) return;
		navigate({ type: 'replace', route: { name: 'items', tab, position: readPosition() } });
		navigate({ type: 'push', route: { name: 'scan', lineId: line.pcdRecId } });
	}

	return (
		<gridLayout rows="auto, auto, auto, *">
			<Header title="Items" />
			<gridLayout row={1} className="tabs" columns="*, *">
				<button col={0} className={tab === 'counted' ? 'tab selected' : 'tab'} text={tabLabel('counted', counters?.pending ?? null)} onTap={() => switchTab('counted')} />
				<button
					col={1}
					className={tab === 'notCounted' ? 'tab selected' : 'tab'}
					text={tabLabel('notCounted', counters?.notCounted ?? null)}
					onTap={() => switchTab('notCounted')}
				/>
			</gridLayout>
			{error && <label row={2} className="content error" textWrap={true} text={error} />}
			{source ? (
				<listView ref={listRef} row={3} items={source} separatorColor="#9aa3b2" onItemLoading={onItemLoading} onItemTap={onItemTap} />
			) : (
				<label row={3} className="list-message" textWrap={true} text={counters ? emptyTabText(tab, counters) : 'Loading…'} />
			)}
		</gridLayout>
	);
}
