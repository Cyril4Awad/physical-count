import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ServiceDataError } from '../parse/errors';

/**
 * Readers for the three Service1.asmx SOAP responses (REBUILD_PLAN §3.1–§3.4).
 * Pure module: no NativeScript imports, so the same code runs in Node tests.
 */

/** Largest response body accepted (§3.5.3). */
export const MAX_RESPONSE_LENGTH = 20 * 1024 * 1024;

export const TABLE_INFO_FIELDS = [
	'TableName',
	'RowsCount',
	'OriginalTableName',
	'LastImportedRow',
	'PullDisplayHeader',
	'InsertInto',
	'PullFinished',
	'PullPreparedDT',
	'SelectedLocation',
	'MachineName',
	'CreateTable',
	'Notes',
] as const;

export type TableInfo = Record<(typeof TABLE_INFO_FIELDS)[number], string>;

const REQUIRED_TABLE_INFO_FIELDS: readonly (keyof TableInfo)[] = [
	'TableName',
	'RowsCount',
	'OriginalTableName',
	'PullDisplayHeader',
	'InsertInto',
	'SelectedLocation',
	'MachineName',
];

export type InitPullTablesResult = { kind: 'tables'; tables: TableInfo[] } | { kind: 'noResults' };
export type PullRecordsResult = { kind: 'records'; valuesQueries: string[] } | { kind: 'noResults' };

/** The service answered with a SOAP Fault (only happens for malformed requests, S12). */
export class SoapFaultError extends Error {
	constructor(public readonly faultString: string) {
		super(`Service fault: ${faultString}`);
		this.name = 'SoapFaultError';
	}
}

const ARRAY_PATHS = new Set([
	'Envelope.Body.InitPullTablesResponse.InitPullTablesResult.mTableInfo.TableInfo',
	'Envelope.Body.pullRecordsResponse.pullRecordsResult.mRecords.Record',
]);

const parser = new XMLParser({
	ignoreAttributes: true,
	removeNSPrefix: true,
	// Keep every value as text: '5285002192105' or '0' must not become numbers.
	parseTagValue: false,
	// Only whitespace around a value is trimmed; the service's values sit inside
	// quotes (valuesquery) or never have meaningful edge whitespace.
	trimValues: true,
	processEntities: true,
	// Also decodes numeric character references (&#233; / &#xE9;).
	htmlEntities: true,
	isArray: (_name, jpath) => ARRAY_PATHS.has(String(jpath)),
});

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(xml: string): Node {
	if (xml.length > MAX_RESPONSE_LENGTH) throw new ServiceDataError('Response is too large');
	const valid = XMLValidator.validate(xml);
	if (valid !== true) throw new ServiceDataError(`Response is not well-formed XML: ${valid.err.msg}`);

	const document = parser.parse(xml) as Node;
	const envelope = document.Envelope;
	const body = isNode(envelope) ? envelope.Body : undefined;
	if (!isNode(body)) throw new ServiceDataError('Response has no SOAP Body');

	const fault = body.Fault;
	if (fault !== undefined) {
		const faultString = isNode(fault) && typeof fault.faultstring === 'string' ? fault.faultstring : 'unknown fault';
		throw new SoapFaultError(faultString);
	}
	return body;
}

/** Walks `path` below `node`. Returns `undefined` when a step is missing or empty (`<x />` parses as ''). */
function child(node: unknown, ...path: string[]): unknown {
	let current = node;
	for (const step of path) {
		if (!isNode(current)) return undefined;
		current = current[step];
	}
	return current === '' ? undefined : current;
}

function requireElement(body: Node, name: string): unknown {
	if (!(name in body)) throw new ServiceDataError(`Response has no ${name}`);
	return body[name];
}

export function readInitPullTables(xml: string): InitPullTablesResult {
	const body = readBody(xml);
	const response = requireElement(body, 'InitPullTablesResponse');
	const list = child(response, 'InitPullTablesResult', 'mTableInfo', 'TableInfo');
	if (list === undefined) return { kind: 'noResults' };
	if (!Array.isArray(list)) throw new ServiceDataError('Unexpected mTableInfo shape');

	const tables = list.map((item, index) => {
		if (!isNode(item)) throw new ServiceDataError(`TableInfo ${index + 1} is empty`);
		const info = {} as TableInfo;
		for (const field of TABLE_INFO_FIELDS) {
			const value = item[field];
			if (value === undefined) info[field] = '';
			else if (typeof value === 'string') info[field] = value;
			else throw new ServiceDataError(`TableInfo ${index + 1}: ${field} is not text`);
		}
		for (const field of REQUIRED_TABLE_INFO_FIELDS) {
			if (item[field] === undefined) throw new ServiceDataError(`TableInfo ${index + 1} has no ${field}`);
		}
		return info;
	});
	return { kind: 'tables', tables };
}

export function readPullRecords(xml: string): PullRecordsResult {
	const body = readBody(xml);
	const response = requireElement(body, 'pullRecordsResponse');
	const list = child(response, 'pullRecordsResult', 'mRecords', 'Record');
	if (list === undefined) return { kind: 'noResults' };
	if (!Array.isArray(list)) throw new ServiceDataError('Unexpected mRecords shape');

	const valuesQueries = list.map((record, index) => {
		const value = isNode(record) ? record.valuesquery : undefined;
		if (typeof value !== 'string') throw new ServiceDataError(`Record ${index + 1} has no valuesquery`);
		return value;
	});
	return { kind: 'records', valuesQueries };
}

export function readInsertDetail(xml: string): string {
	const body = readBody(xml);
	const response = requireElement(body, 'InsertDetailResponse');
	const result = isNode(response) ? response.InsertDetailResult : undefined;
	if (result === undefined) throw new ServiceDataError('Response has no InsertDetailResult');
	return typeof result === 'string' ? result : '';
}
