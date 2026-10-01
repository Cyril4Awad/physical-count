import { defineConfig } from 'vitest/config';

// Pure-logic unit tests that run in Node (no device). Device tests use vitest.config.mts.
export default defineConfig({
	test: {
		include: ['tests/node/**/*.test.ts'],
		environment: 'node',
	},
});
