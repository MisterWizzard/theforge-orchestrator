import { defineConfig } from 'tsup';

export default defineConfig({
  // testing.ts is the in-process fake Ollama server; the worker's tests import
  // it through the package's `./testing` export, so it is built alongside.
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: true,
});
