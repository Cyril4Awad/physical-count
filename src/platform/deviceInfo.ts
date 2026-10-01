import { formatDeviceInfo } from '../soap/envelopes';

/** Legacy DeviceInfo text for InitPullTables (Build.MODEL / MANUFACTURER / BRAND); the service ignores it (S16). */
export function deviceInfoText(): string {
	return formatDeviceInfo({ model: android.os.Build.MODEL, manufacturer: android.os.Build.MANUFACTURER, brand: android.os.Build.BRAND });
}
