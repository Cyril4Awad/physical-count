import { InvalidInputError, valueOf } from '../domain/check';
import { checkUploadQuantity, formatForUpload, Milli } from '../domain/decimal';
import {
	checkCountNumber,
	checkLocationCode,
	checkMachineName,
	checkPcdRecId,
	checkServerAddress,
	checkTransCount,
	checkUserToUpdate,
	MAX_PAGE_SIZE,
} from '../domain/validation';

/**
 * SOAP 1.1 request builders for Service1.asmx (REBUILD_PLAN §3.1), built by
 * hand in the exact form of docs/service-samples/*.request.xml. Every value is
 * checked again here (§3.7) before it goes into an envelope; an invalid value
 * throws InvalidInputError and no request is built.
 */

export const SERVICE_NAMESPACE = 'http://tempuri.org/';
export const APPLICATION_NAME = 'ERPDATACOLLECTOR';

export type SoapMethod = 'InitPullTables' | 'pullRecords' | 'InsertDetail';

export function soapAction(method: SoapMethod): string {
	return `${SERVICE_NAMESPACE}${method}`;
}

/** `http://<server>/ERPDataCollector/Service1.asmx` from a profile's server address (legacy format). */
export function serviceUrl(serverAddress: string): string {
	return `http://${valueOf(checkServerAddress(serverAddress))}/ERPDataCollector/Service1.asmx`;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function envelope(method: SoapMethod, params: readonly (readonly [string, string])[]): string {
	const body = params.map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('');
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
		`<${method} xmlns="${SERVICE_NAMESPACE}">${body}</${method}>` +
		'</soap:Body></soap:Envelope>'
	);
}

/** Characters XML 1.0 cannot carry at all (device strings are not trusted to be clean). */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Legacy DeviceInfo text (Build.MODEL / MANUFACTURER / BRAND). The service ignores it (S16). */
export function formatDeviceInfo(device: { model: string; manufacturer: string; brand: string }): string {
	const clean = (text: string) => (text ?? '').replace(XML_INVALID, '').replace(/[\r\n]/g, ' ').slice(0, 100);
	return `Device Model: ${clean(device.model)}\nDevice Manufacturer: ${clean(device.manufacturer)}\nDevice Brand: ${clean(device.brand)}\n`;
}

export function buildInitPullTables(request: { location: string; machine: string; countNumber: string; deviceInfo: string }): string {
	return envelope('InitPullTables', [
		['ApplicationName', APPLICATION_NAME],
		['SelectedLocation', valueOf(checkLocationCode(request.location))],
		['MachineName', valueOf(checkMachineName(request.machine))],
		['Extras', valueOf(checkCountNumber(request.countNumber))],
		['DeviceInfo', request.deviceInfo.replace(XML_INVALID, '')],
	]);
}

/** Shape check; the exact location + machine match is done when the manifest is built (parse/manifest.ts). */
const TABLE_NAME = /^_ERPDATACOLLECTOR_tbl_PhysicalCount(Header|Detail|DetBarcode)_[A-Za-z0-9]{2,7}$/;

export function buildPullRecords(request: { tableName: string; pageSize: number; startFromRow: number }): string {
	if (!TABLE_NAME.test(request.tableName)) throw new InvalidInputError(`Invalid server table name "${request.tableName}".`);
	if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE) {
		throw new InvalidInputError(`Invalid page size ${request.pageSize}.`);
	}
	if (!Number.isSafeInteger(request.startFromRow) || request.startFromRow < 1) throw new InvalidInputError(`Invalid start row ${request.startFromRow}.`);
	return envelope('pullRecords', [
		['TableName', request.tableName],
		['PIndex', '0'],
		['PSize', String(request.pageSize)],
		['StartFromRow', String(request.startFromRow)],
	]);
}

export function buildInsertDetail(request: {
	transCount: number;
	location: string;
	invId: string;
	localId: number;
	pcdRecId: string;
	counted: Milli;
	userToUpdate: string;
}): string {
	if (!Number.isSafeInteger(request.localId) || request.localId < 1) throw new InvalidInputError(`Invalid local id ${request.localId}.`);
	return envelope('InsertDetail', [
		['transCount', String(valueOf(checkTransCount(request.transCount)))],
		['SelectedLocation', valueOf(checkLocationCode(request.location))],
		['uInvID', valueOf(checkCountNumber(request.invId))],
		['id', String(request.localId)],
		['Pcd_RecId', valueOf(checkPcdRecId(request.pcdRecId))],
		['usercounted', formatForUpload(valueOf(checkUploadQuantity(request.counted)))],
		['uUserToUpdate', valueOf(checkUserToUpdate(request.userToUpdate))],
	]);
}
