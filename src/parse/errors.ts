/** Raised when text from the service does not have the expected shape. The whole page or download is rejected. */
export class ServiceDataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServiceDataError';
	}
}
