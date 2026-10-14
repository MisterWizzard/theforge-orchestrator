import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: true,
  // migrate.ts and testing.ts read the SQL files relative to import.meta.url,
  // exactly as the sources do, so dist/ must carry the same migrations/ layout.
  async onSuccess() {
    await mkdir('dist/migrations', { recursive: true });
    for (const name of await readdir('src/migrations')) {
      if (name.endsWith('.sql')) {
        await copyFile(`src/migrations/${name}`, `dist/migrations/${name}`);
      }
    }
  },
});
