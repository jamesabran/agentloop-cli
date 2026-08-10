import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    // vitest 4.x / rolldown cannot parse scripts/lint.mjs as a dependency
    // (SyntaxError: Invalid or unexpected token).  node --check and acorn
    // both accept it.  Treat it as external so vitest loads it directly
    // without transformation.
    server: {
      deps: {
        external: [/scripts\/lint\.mjs$/],
      },
    },
  },
});
