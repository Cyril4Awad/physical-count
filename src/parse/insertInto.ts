import { ServiceDataError } from './errors';

const INSERT_INTO = /^\s*Insert\s+Into\s+(\w+)\s*\((.*)\)\s*Values\s*$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads the column list out of the service's `InsertInto` text
 * (`Insert Into phyDetails(RowNumber,…) Values`, REBUILD_PLAN §3.5.1).
 * The text is only parsed, never executed.
 */
export function parseInsertInto(text: string, expectedTable: string): string[] {
	const match = INSERT_INTO.exec(text);
	if (!match) throw new ServiceDataError(`Unrecognised InsertInto text for ${expectedTable}`);
	if (match[1] !== expectedTable) throw new ServiceDataError(`InsertInto names table ${match[1]}, expected ${expectedTable}`);

	const columns = match[2].split(',').map((column) => column.trim());
	for (const column of columns) {
		if (!IDENTIFIER.test(column)) throw new ServiceDataError(`Invalid column name in InsertInto for ${expectedTable}: "${column}"`);
	}
	return columns;
}
