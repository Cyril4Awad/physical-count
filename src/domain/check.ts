/** Result of an input check: the accepted value, or a message for the operator. */
export type Check<T> = { ok: true; value: T } | { ok: false; message: string };

export function accept<T>(value: T): Check<T> {
	return { ok: true, value };
}

export function reject<T = never>(message: string): Check<T> {
	return { ok: false, message };
}

/** Raised when a value that should already have been checked reaches a SOAP request builder (§3.7). */
export class InvalidInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidInputError';
	}
}

/** Returns the value of a passed check, or throws InvalidInputError. */
export function valueOf<T>(check: Check<T>): T {
	if (!check.ok) throw new InvalidInputError(check.message);
	return check.value;
}
