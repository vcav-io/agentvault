import { defineConfig } from 'vitest/config';

// Most suites exercise relay flows without a pinned relay key, which only
// development allows. Suites that test the pin requirement unset SELKEY_ENV.
export default defineConfig({
  test: {
    env: { SELKEY_ENV: 'dev' },
  },
});
