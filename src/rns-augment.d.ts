import type { EventData } from '@nativescript/core';

// react-nativescript maps any onXyz prop to the NativeScript "xyz" event, but its typings
// omit TextField's returnPress (Enter / IME action). Used by Download and, later, the scan field.
declare module 'react-nativescript/dist/lib/react-nativescript-jsx' {
	interface TextFieldAttributes {
		onReturnPress?: (args: EventData) => void;
	}
}
