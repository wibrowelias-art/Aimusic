import { defineConfig } from 'vitest/config';

// `npm run measure` renders pieces offline and writes the numbers that go into TUNING.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/measure/**/*.measure.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
