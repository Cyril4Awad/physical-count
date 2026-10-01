import { isAndroid, Utils } from '@nativescript/core';

/**
 * FLAG_KEEP_SCREEN_ON on the activity window during download and upload
 * (REBUILD_PLAN §6.1, §6.2). No wake-lock permission is needed.
 */
export function keepScreenOn(on: boolean): void {
	if (!isAndroid) return;
	const window = Utils.android.getCurrentActivity()?.getWindow();
	if (!window) return;
	const flag = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
	if (on) window.addFlags(flag);
	else window.clearFlags(flag);
}
