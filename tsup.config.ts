import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['node-pty'],
});
