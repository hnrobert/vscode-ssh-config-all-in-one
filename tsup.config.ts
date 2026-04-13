import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'out',
  format: ['cjs'],
  platform: 'node',
  target: 'node16',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  shims: false,
  skipNodeModulesBundle: false,
  external: ['vscode'],
});
