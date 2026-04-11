import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    redis: 'src/engines/redis/index.ts',
    postgres: 'src/engines/postgres/index.ts',
    memory: 'src/engines/memory/index.ts',
    next: 'src/contrib/next/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['redis', 'pg', 'next', 'react'],
});
