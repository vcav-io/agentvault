import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most suites mock `selkey/contracts` with schema-less contracts and share
    // a working directory, so the owner-side disclosure ledger is off by
    // default here. entropy-ledger*.test.ts enable it explicitly.
    env: { SELKEY_ENTROPY_LEDGER: 'off' },
  },
});
