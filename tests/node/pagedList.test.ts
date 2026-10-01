import { describe, expect, it } from 'vitest';
import { PagedList } from '../../src/domain/pagedList';

const TOTAL = 11131;

/** A list of the numbers 0…total-1 served in pages, recording every request. */
function numbers(total = TOTAL, options: { pageSize?: number; maxPages?: number } = {}) {
	const requests: number[] = [];
	let loaded = 0;
	let peak = 0;
	const list: PagedList<number> = new PagedList<number>({
		total,
		pageSize: options.pageSize ?? 100,
		maxPages: options.maxPages ?? 6,
		loadPage: async (offset, limit) => {
			requests.push(offset);
			return Array.from({ length: Math.min(limit, total - offset) }, (_, i) => offset + i);
		},
		onPageLoaded: () => {
			loaded++;
			peak = Math.max(peak, list.loadedRows);
		},
	});
	return { list, requests, loaded: () => loaded, peak: () => peak };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PagedList', () => {
	it('has the length of the whole list without loading anything', () => {
		const { list, requests } = numbers();
		expect(list.length).toBe(TOTAL);
		expect(list.loadedRows).toBe(0);
		expect(requests).toEqual([]);
	});

	it('returns null while a page loads, then the row', async () => {
		const { list, requests, loaded } = numbers();
		expect(list.getItem(0)).toBeNull();
		await settle();
		expect(list.getItem(0)).toBe(0);
		expect(list.getItem(99)).toBe(99);
		expect(requests).toContain(0);
		expect(loaded()).toBeGreaterThan(0);
	});

	it('asks for a page once, however many rows of it are requested', async () => {
		const { list, requests } = numbers();
		for (let i = 40; i < 60; i++) list.getItem(i);
		await settle();
		for (let i = 40; i < 60; i++) expect(list.getItem(i)).toBe(i);
		expect(requests).toEqual([0]);
	});

	it('reads the next page ahead near the end of a page, and the previous one near the start', async () => {
		const { list, requests } = numbers();
		list.getItem(560);
		await settle();
		expect(requests.sort((a, b) => a - b)).toEqual([500, 600]);
		list.getItem(510);
		await settle();
		expect(requests.sort((a, b) => a - b)).toEqual([400, 500, 600]);
	});

	it('scrolling the whole list top to bottom never holds more than 6 pages', async () => {
		const { list, peak } = numbers();
		for (let index = 0; index < TOTAL; index++) {
			if (list.getItem(index) === null) {
				await settle();
				expect(list.getItem(index)).toBe(index);
			}
			expect(list.loadedRows).toBeLessThanOrEqual(600);
		}
		expect(peak()).toBeLessThanOrEqual(600);
		expect(list.getItem(TOTAL - 1)).toBe(TOTAL - 1);
		// The top of the list was dropped on the way down and is read again on the way back.
		expect(list.peek(0)).toBeNull();
		expect(list.getItem(0)).toBeNull();
		await settle();
		expect(list.getItem(0)).toBe(0);
	});

	it('after a fling, loads the pages asked for last and skips the ones passed on the way', async () => {
		const { list, requests } = numbers();
		for (let index = 0; index < TOTAL; index += 10) list.getItem(index);
		await settle();
		expect(requests.length).toBeLessThanOrEqual(7);
		expect(list.peek(TOTAL - 1)).toBe(TOTAL - 1);
		expect(list.loadedRows).toBeLessThanOrEqual(600);
	});

	it('the last page is short and rows beyond the end are null', async () => {
		const { list, requests } = numbers();
		list.getItem(TOTAL - 1);
		await settle();
		expect(list.getItem(TOTAL - 1)).toBe(TOTAL - 1);
		expect(list.getItem(TOTAL)).toBeNull();
		expect(list.getItem(-1)).toBeNull();
		expect(requests.every((offset) => offset < TOTAL)).toBe(true);
	});

	it('peek never starts a load', async () => {
		const { list, requests } = numbers();
		expect(list.peek(5000)).toBeNull();
		await settle();
		expect(requests).toEqual([]);
	});

	it('an empty list loads nothing', async () => {
		const { list, requests } = numbers(0);
		expect(list.length).toBe(0);
		expect(list.getItem(0)).toBeNull();
		await settle();
		expect(requests).toEqual([]);
	});

	it('dispose drops the pages and ignores a page that arrives afterwards', async () => {
		const { list, loaded } = numbers();
		list.getItem(0);
		list.dispose();
		await settle();
		expect(loaded()).toBe(0);
		expect(list.loadedRows).toBe(0);
		expect(list.getItem(0)).toBeNull();
	});

	it('reports a failed page and loads it again when asked later', async () => {
		let fail = true;
		const errors: unknown[] = [];
		const list = new PagedList<number>({
			total: 250,
			pageSize: 100,
			maxPages: 3,
			loadPage: async (offset) => {
				if (fail) throw new Error('database closed');
				return [offset];
			},
			onError: (error) => errors.push(error),
		});
		list.getItem(50);
		await settle();
		expect(errors).toHaveLength(1);
		fail = false;
		expect(list.getItem(50)).toBeNull();
		await settle();
		expect(list.peek(0)).toBe(0);
	});

	it('refuses a page size or page limit that cannot work', () => {
		const loadPage = async () => [];
		expect(() => new PagedList({ total: 10, pageSize: 0, maxPages: 6, loadPage })).toThrow('Invalid page size');
		expect(() => new PagedList({ total: 10, pageSize: 100, maxPages: 2, loadPage })).toThrow('Invalid page limit');
	});
});
