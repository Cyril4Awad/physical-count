import { ServiceDataError } from './errors';

/** Staging column `valuesquery` is nvarchar(4000), so no single value can be longer (§3.5.3). */
export const MAX_VALUE_LENGTH = 4000;

/**
 * Splits one `valuesquery` string into its values (REBUILD_PLAN §3.5.2).
 *
 * Expected shape: `'v1','v2',…,'vn'` — every value single-quoted, no `''`
 * escapes (the service strips apostrophes), whitespace allowed only outside
 * quotes. Anything else is an error; nothing is ever executed.
 */
export function tokenizeValuesQuery(text: string): string[] {
	const values: string[] = [];
	let i = 0;
	const n = text.length;

	const skipWhitespace = () => {
		while (i < n && /\s/.test(text[i])) i++;
	};

	skipWhitespace();
	if (i === n) throw new ServiceDataError('Empty value list');

	for (;;) {
		if (text[i] !== "'") throw new ServiceDataError(`Expected a quoted value at position ${i}`);
		const close = text.indexOf("'", i + 1);
		if (close < 0) throw new ServiceDataError(`Unterminated quoted value at position ${i}`);
		const value = text.slice(i + 1, close);
		if (value.length > MAX_VALUE_LENGTH) throw new ServiceDataError(`Value at position ${i} is longer than ${MAX_VALUE_LENGTH} characters`);
		values.push(value);
		i = close + 1;
		skipWhitespace();
		if (i === n) return values;
		if (text[i] !== ',') throw new ServiceDataError(`Expected ',' at position ${i}`);
		i++;
		skipWhitespace();
	}
}
