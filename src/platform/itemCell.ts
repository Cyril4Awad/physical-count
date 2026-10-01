import { GridLayout, ItemSpec, Label, View } from '@nativescript/core';
import type { ItemRowText } from '../domain/itemText';

/**
 * One row of the Items lists (REBUILD_PLAN §2.1), built from plain NativeScript views.
 * The list recycles about a screenful of these while 11,000 lines scroll past, so a
 * row is created once and then only its label texts change: no React render per row.
 */

interface Cell {
	reference: Label;
	description: Label;
	detail: Label;
	qty: Label;
	qtyLabel: Label;
}

const cells = new WeakMap<View, Cell>();

function label(grid: GridLayout, className: string, row: number, col: number, colSpan = 1): Label {
	const view = new Label();
	view.className = className;
	view.textWrap = false;
	GridLayout.setRow(view, row);
	GridLayout.setColumn(view, col);
	if (colSpan > 1) GridLayout.setColumnSpan(view, colSpan);
	grid.addChild(view);
	return view;
}

export function createItemCell(): View {
	const grid = new GridLayout();
	grid.className = 'item-row';
	grid.addColumn(new ItemSpec(1, 'star'));
	grid.addColumn(new ItemSpec(1, 'auto'));
	for (let row = 0; row < 3; row++) grid.addRow(new ItemSpec(1, 'auto'));
	cells.set(grid, {
		reference: label(grid, 'item-ref', 0, 0),
		qty: label(grid, 'item-qty', 0, 1),
		description: label(grid, 'item-desc', 1, 0),
		qtyLabel: label(grid, 'item-qty-label', 1, 1),
		detail: label(grid, 'item-detail', 2, 0, 2),
	});
	return grid;
}

/** `row` null: the line's page is still loading from SQLite; the row keeps its height and shows a placeholder. */
export function bindItemCell(view: View, row: ItemRowText | null, showDetail: boolean): void {
	const cell = cells.get(view);
	if (!cell) return;
	cell.reference.text = row ? row.reference : '…';
	cell.description.text = row ? row.description : ' ';
	cell.qty.text = row ? row.qty : '';
	cell.qtyLabel.text = row ? row.qtyLabel : '';
	cell.detail.text = row ? row.detail : ' ';
	cell.detail.visibility = showDetail ? 'visible' : 'collapse';
}
