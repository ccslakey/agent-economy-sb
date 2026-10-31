import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    typecheck: { enabled: true, include: ['packages/*/src/**/*.test.ts'] },
  },
});
