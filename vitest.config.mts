import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { nativeScript } from '@nativescript/unit-test-runner';

// On-device tests (src/**/*.spec.ts), run with `ns test android`.
// Pure-logic tests run in Node with vitest.node.config.mts.

const platform = process.env.NS_PLATFORM || 'android';
const device = process.env.NS_DEVICE || undefined;
const port = 17878; // the runner's default

// The runner launches the app with `npx ns run …`, which Node cannot spawn on
// Windows without a shell (npx is a .cmd file). Run the global CLI with node instead.
function windowsLaunchCommand() {
	const ns = join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'nativescript', 'bin', 'ns');
	const args = [ns, 'run', platform, '--no-hmr', '--env.unitTesting', `--env.testRunnerPort=${port}`];
	if (device) args.push('--device', device);
	return { command: process.execPath, args };
}

export default defineConfig({
	plugins: [
		nativeScript({
			platform,
			device,
			port,
			// The first run includes a Gradle build (~75 s here) before the app can connect.
			connectTimeout: 600_000,
			launchCommand: process.platform === 'win32' ? windowsLaunchCommand() : undefined,
		}),
	],
	test: {
		// Device runs include app startup and real layout passes.
		testTimeout: 120_000,
	},
});
