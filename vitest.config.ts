import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/vscodeMock.ts'),
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});
