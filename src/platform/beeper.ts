/**
 * Scan sounds (REBUILD_PLAN §5.4, D6): one ToneGenerator, created when Scan
 * opens and released when it closes (legacy leaked one per miss).
 */
export class Beeper {
	private tone: android.media.ToneGenerator | null;

	constructor() {
		this.tone = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 100);
		console.log('[scan] ToneGenerator created');
	}

	/** Good scan: one short beep. */
	good(): void {
		this.tone?.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 100);
	}

	/** Not found / invalid QR: the legacy alert, clearly different. */
	bad(): void {
		this.tone?.startTone(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200);
	}

	release(): void {
		if (!this.tone) return;
		this.tone.release();
		this.tone = null;
		console.log('[scan] ToneGenerator released');
	}
}
