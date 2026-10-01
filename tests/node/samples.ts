import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SAMPLES_DIR = join(__dirname, '..', '..', 'docs', 'service-samples');

/** Reads one saved SOAP sample from docs/service-samples/. */
export function sample(name: string): string {
	return readFileSync(join(SAMPLES_DIR, name), 'utf8');
}

export function envelope(body: string): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
		'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>' +
		body +
		'</soap:Body></soap:Envelope>'
	);
}

export function pullRecordsResponse(valuesQueries: string[]): string {
	const records = valuesQueries.map((v) => `<Record><valuesquery>${v}</valuesquery></Record>`).join('');
	return envelope(`<pullRecordsResponse xmlns="http://tempuri.org/"><pullRecordsResult><mRecords>${records}</mRecords></pullRecordsResult></pullRecordsResponse>`);
}
