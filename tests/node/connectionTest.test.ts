import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpGet, testConnection } from '../../src/soap/connectionTest';

const WSDL = readFileSync(join(__dirname, '..', '..', 'docs', 'service-samples', 'Service1.wsdl'), 'utf8');

function get(answer: Awaited<ReturnType<HttpGet>> | Error) {
	const urls: string[] = [];
	const fn: HttpGet = async (url, timeoutMs) => {
		urls.push(`${url} ${timeoutMs}`);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { fn, urls };
}

describe('Test connection (GET …?WSDL, no service method)', () => {
	it('is reachable when the service WSDL comes back', async () => {
		const { fn, urls } = get({ statusCode: 200, body: WSDL });
		expect(await testConnection('10.0.2.2', fn)).toEqual({ reachable: true, message: 'Reachable: 10.0.2.2' });
		expect(urls).toEqual(['http://10.0.2.2/ERPDataCollector/Service1.asmx?WSDL 10000']);
	});

	it.each([
		['an HTTP error', { statusCode: 404, body: 'Not found' }, 'HTTP 404 from http://10.0.2.2/ERPDataCollector/Service1.asmx?WSDL'],
		['another web page', { statusCode: 200, body: '<html>IIS Windows Server</html>' }, 'http://10.0.2.2/ERPDataCollector/Service1.asmx?WSDL answered, but it is not the ERPDataCollector service'],
		['no connection', new Error('java.net.ConnectException: Failed to connect to /10.0.2.2:80'), 'java.net.ConnectException: Failed to connect to /10.0.2.2:80'],
	])('is not reachable on %s', async (_label, answer, detail) => {
		expect(await testConnection('10.0.2.2', get(answer).fn)).toEqual({ reachable: false, message: 'Not reachable.', detail });
	});

	it('does not send anything for an invalid address', async () => {
		const { fn, urls } = get({ statusCode: 200, body: WSDL });
		expect(await testConnection('http://10.0.2.2', fn)).toMatchObject({ reachable: false });
		expect(urls).toEqual([]);
	});
});
