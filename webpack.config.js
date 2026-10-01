const path = require("path");
const webpack = require("@nativescript/webpack");

module.exports = (env) => {
	webpack.init(env);

	// Learn how to customize:
	// https://docs.nativescript.org/webpack

	// The saved SOAP responses in docs/service-samples are loaded as plain text
	// by the on-device tests; they are not NativeScript XML UI files.
	const serviceSamples = path.resolve(__dirname, "docs/service-samples");
	webpack.chainWebpack((config) => {
		config.module.rule("xml").exclude.add(serviceSamples);
		config.module
			.rule("service-samples")
			.test(/\.xml$/)
			.include.add(serviceSamples)
			.end()
			.type("asset/source");
	});

	// __DEBUG_TOOLS__: true only in debug builds; release builds drop the debug-only code paths.
	webpack.chainWebpack((config) => {
		config.plugin("DefinePlugin").tap((args) => {
			args[0] = { ...args[0], __DEBUG_TOOLS__: JSON.stringify(!env.production) };
			return args;
		});
	});

	// Debug-only live download check (src/debug/liveDownload.ts): replaces the app
	// entry when built with --env.liveDownload, never in a release build.
	if (env.liveDownload && !env.production) {
		webpack.chainWebpack((config) => {
			const entry = config.entry("bundle").clear();
			entry.add("@nativescript/core/globals/index.js").add("@nativescript/core/bundle-entry-points");
			if (webpack.Utils.platform.getPlatformName() === "android") {
				// The static binding generator needs these to generate the activity.
				entry.add("@nativescript/core/ui/frame").add("@nativescript/core/ui/frame/activity");
			}
			entry.add(path.resolve(__dirname, "src/debug/liveDownload.ts"));
		});
	}

	return webpack.resolveConfig();
};
