import { TextField, Utils } from '@nativescript/core';
import type { ScannerInput } from '../storage/deviceSettings';

/**
 * Keyboard-wedge scan field (REBUILD_PLAN §9.3). The scanner types the code
 * into the focused field and presses Enter.
 *
 * - No soft keyboard: `setShowSoftInputOnFocus(false)`; tapping focuses without it.
 * - Scanner input `keyEvents` (default): single line and `InputType.TYPE_NULL`, no input-method (IME)
 *   connection at all. With a normal text input type the keyboard app (Gboard on the emulator) stays
 *   attached even when hidden and handles some hardware key events itself, asynchronously; in step 7,
 *   3 of 20 rapid scans arrived with characters out of order. The field's own key listener still
 *   types wedge characters.
 * - Scanner input `textInput` (Settings → Advanced): a normal text field with suggestions off, as
 *   before that fix, for a scanner whose output is committed through an input method and would type
 *   nothing into a `TYPE_NULL` field. An Enter that arrives as an editor action counts as a scan too.
 * - Enter is caught by a native OnKeyListener on ACTION_DOWN and **both** key actions are
 *   consumed, so NativeScript's own returnPress (which can fire twice and hides the keyboard)
 *   never runs. NUMPAD_ENTER counts too.
 * - `rearm()`: about 100 ms later, focus the field again (native requestFocus: NativeScript's
 *   focus() would open the soft keyboard) and select all, so the next scan replaces the text.
 */

/** One Enter can reach a text field both as a key event and as an editor action. */
const SAME_ENTER_MS = 50;

export class ScanField {
	private editText: android.widget.EditText | null = null;
	private rearmTimer: ReturnType<typeof setTimeout> | null = null;
	private lastEnterAt = 0;

	constructor(private readonly onScan: (value: string) => void) {}

	/** Call from the TextField's `loaded` event, with the scanner input chosen in Settings. */
	attach(field: TextField, mode: ScannerInput = 'keyEvents'): void {
		const editText = field.android as android.widget.EditText | undefined;
		if (!editText || this.editText === editText) return;
		this.editText = editText;

		const InputType = android.text.InputType;
		editText.setShowSoftInputOnFocus(false);
		editText.setSingleLine(true);
		editText.setInputType(mode === 'textInput' ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS : InputType.TYPE_NULL);
		editText.setSelectAllOnFocus(false);
		console.log(`[scan] scanner input: ${mode} (inputType ${editText.getInputType()})`);

		const self = this;
		const enter = () => {
			const now = Date.now();
			if (now - self.lastEnterAt < SAME_ENTER_MS) return;
			self.lastEnterAt = now;
			const value = editText.getText().toString();
			// Select at once, so characters of a fast next scan replace this one instead of appending.
			editText.selectAll();
			self.onScan(value);
			self.rearm();
		};
		editText.setOnKeyListener(
			new android.view.View.OnKeyListener({
				onKey(view: android.view.View, keyCode: number, event: android.view.KeyEvent): boolean {
					if (keyCode !== android.view.KeyEvent.KEYCODE_ENTER && keyCode !== android.view.KeyEvent.KEYCODE_NUMPAD_ENTER) return false;
					if (event.getAction() === android.view.KeyEvent.ACTION_DOWN) enter();
					return true;
				},
			}),
		);
		if (mode === 'textInput') {
			editText.setOnEditorActionListener(
				new android.widget.TextView.OnEditorActionListener({
					onEditorAction(view: android.widget.TextView, actionId: number, event: android.view.KeyEvent): boolean {
						if (!event || event.getAction() === android.view.KeyEvent.ACTION_DOWN) enter();
						return true;
					},
				}),
			);
		}
		this.rearm();
	}

	detach(): void {
		if (this.rearmTimer) clearTimeout(this.rearmTimer);
		this.editText = null;
	}

	/**
	 * Focus the scan field again and select its text, ~100 ms later (legacy Reinit()).
	 * Selecting is skipped when new characters have arrived since, so a scan being typed is not cut.
	 */
	rearm(): void {
		const editText = this.editText;
		if (!editText) return;
		const textNow = editText.getText().toString();
		if (this.rearmTimer) clearTimeout(this.rearmTimer);
		this.rearmTimer = setTimeout(() => {
			if (this.editText !== editText) return;
			if (!editText.hasFocus()) editText.requestFocus();
			if (editText.getText().toString() === textNow) editText.selectAll();
			Utils.android.dismissSoftInput(editText);
		}, 100);
	}

	/** Clears the field (used when the screen shows a message rather than a scanned value). */
	clear(): void {
		this.editText?.setText('');
	}
}
