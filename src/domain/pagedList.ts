/**
 * A window over a long list that lives in SQLite (Items, REBUILD_PLAN §2.1).
 * The list view asks for rows by index; rows come from fixed-size pages loaded
 * on demand, and only the most recently used pages are kept, so the whole
 * sheet is never in memory. Pure module: no NativeScript imports.
 *
 * It has the shape NativeScript's ListView accepts as `items` (`length` + `getItem`).
 */
export type LoadPage<T> = (offset: number, limit: number) => Promise<T[]>;

export interface PagedListOptions<T> {
	/** Number of rows in the whole list. */
	total: number;
	pageSize: number;
	/** Pages kept in memory; the least recently used one is dropped beyond this. At least 3. */
	maxPages: number;
	loadPage: LoadPage<T>;
	/** Called after a page arrives, so the list view can redraw the rows it showed as placeholders. */
	onPageLoaded?: () => void;
	onError?: (error: unknown) => void;
}

export class PagedList<T> {
	readonly length: number;
	private readonly pages = new Map<number, T[]>();
	/** Pages asked for and not loaded yet, oldest first. Only the newest ones are worth loading after a fling. */
	private wanted: number[] = [];
	private loading: number | null = null;
	private disposed = false;

	constructor(private readonly options: PagedListOptions<T>) {
		if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1) throw new Error(`Invalid page size ${options.pageSize}`);
		if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 3) throw new Error(`Invalid page limit ${options.maxPages}`);
		this.length = Math.max(0, options.total);
	}

	/** The row at `index`, or null while its page is loading (the caller shows a placeholder). */
	getItem(index: number): T | null {
		if (index < 0 || index >= this.length) return null;
		const { pageSize } = this.options;
		const page = Math.floor(index / pageSize);
		// Read ahead in the direction of travel, so a steady scroll never shows placeholders.
		const within = index - page * pageSize;
		if (within >= pageSize * 0.6) this.want(page + 1);
		else if (within < pageSize * 0.4) this.want(page - 1);
		const rows = this.touch(page);
		if (!rows) {
			this.want(page);
			return null;
		}
		return rows[within] ?? null;
	}

	/** The row at `index` if it is in memory; never starts a load. */
	peek(index: number): T | null {
		if (index < 0 || index >= this.length) return null;
		const { pageSize } = this.options;
		return this.pages.get(Math.floor(index / pageSize))?.[index % pageSize] ?? null;
	}

	/** Rows currently held in memory. */
	get loadedRows(): number {
		let n = 0;
		this.pages.forEach((rows) => (n += rows.length));
		return n;
	}

	/** Stops loading and drops the pages (the screen closed, or the list was replaced). */
	dispose(): void {
		this.disposed = true;
		this.wanted = [];
		this.pages.clear();
	}

	/** Marks a loaded page as the most recently used one. */
	private touch(page: number): T[] | undefined {
		const rows = this.pages.get(page);
		if (rows) {
			this.pages.delete(page);
			this.pages.set(page, rows);
		}
		return rows;
	}

	private want(page: number): void {
		if (this.disposed || page < 0 || page * this.options.pageSize >= this.length) return;
		if (this.pages.has(page) || this.loading === page) return;
		this.wanted = this.wanted.filter((p) => p !== page);
		this.wanted.push(page);
		// A fling passes many pages; keep only the last few asked for.
		if (this.wanted.length > this.options.maxPages - 1) this.wanted.shift();
		void this.pump();
	}

	/** One load at a time, newest request first. */
	private async pump(): Promise<void> {
		if (this.loading !== null) return;
		while (!this.disposed && this.wanted.length > 0) {
			const page = this.wanted.pop() as number;
			this.loading = page;
			try {
				const rows = await this.options.loadPage(page * this.options.pageSize, this.options.pageSize);
				if (this.disposed) break;
				this.pages.set(page, rows);
				while (this.pages.size > this.options.maxPages) this.pages.delete(this.pages.keys().next().value as number);
				this.options.onPageLoaded?.();
			} catch (error) {
				if (!this.disposed) this.options.onError?.(error);
			} finally {
				this.loading = null;
			}
		}
	}
}
