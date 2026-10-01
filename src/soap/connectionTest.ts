import { CONNECTION_TEST_TIMEOUT_MS } from '../config';
import { InvalidInputError } from '../domain/check';
import { serviceUrl } from './envelopes';

/**
 * Settings → Test connection (REBUILD_PLAN §2.2): a GET for
 * `…/Service1.asmx?WSDL`. It calls no service method, so nothing is written
 * on the server; it only reports reachable or not. Pure: the GET is injected.
 */

export type HttpGet = (url: string, timeoutMs: number) => Promise<{ statusCode: number; body: string }>;

export type ConnectionResult = { reachable: true; message: string } | { reachable: false; message: string; detail: string };

export async function testConnection(serverAddress: string, get: HttpGet): Promise<ConnectionResult> {
	let url: string;
	try {
		url = `${serviceUrl(serverAddress)}?WSDL`;
	} catch (error) {
		if (error instanceof InvalidInputError) return { reachable: false, message: 'Not reachable.', detail: error.message };
		throw error;
	}
	try {
		const response = await get(url, CONNECTION_TEST_TIMEOUT_MS);
		if (response.statusCode !== 200) return { reachable: false, message: 'Not reachable.', detail: `HTTP ${response.statusCode} from ${url}` };
		// The service's own WSDL names its methods; anything else is another web page at that address.
		if (!response.body.includes('InitPullTables')) {
			return { reachable: false, message: 'Not reachable.', detail: `${url} answered, but it is not the ERPDataCollector service` };
		}
		return { reachable: true, message: `Reachable: ${serverAddress}` };
	} catch (error) {
		return { reachable: false, message: 'Not reachable.', detail: error instanceof Error ? error.message : String(error) };
	}
}
