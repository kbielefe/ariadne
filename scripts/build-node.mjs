// Bundles the server and the runner into dist/, next to the web build and the migrations.
import { cpSync } from 'node:fs';
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };
await build({ ...common, entryPoints: ['src/server/main.ts'], outfile: 'dist/server.mjs' });
await build({ ...common, entryPoints: ['src/runner/main.ts'], outfile: 'dist/runner.mjs' });
cpSync('src/server/migrations', 'dist/migrations', { recursive: true });
console.log('built dist/server.mjs, dist/runner.mjs, dist/migrations');
