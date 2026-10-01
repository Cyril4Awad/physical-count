import { Http } from '@nativescript/core';
import type { Transport } from './client';
import type { HttpGet } from './connectionTest';

/**
 * The device transport for SoapClient: `Http.request` from @nativescript/core
 * (runs off the UI thread). Resolves with any HTTP status; rejects only when
 * no answer arrived (refused, DNS, cleartext blocked, timeout).
 */
export const httpTransport: Transport = async ({ url, soapAction, body, timeoutMs }) => {
	const response = await Http.request({
		url,
		method: 'POST',
		headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction },
		content: body,
		timeout: timeoutMs,
	});
	return { statusCode: response.statusCode, body: response.content?.toString() ?? '' };
};

/** GET used by Settings → Test connection (connectionTest.ts). */
export const httpGet: HttpGet = async (url, timeoutMs) => {
	const response = await Http.request({ url, method: 'GET', timeout: timeoutMs });
	return { statusCode: response.statusCode, body: response.content?.toString() ?? '' };
};
