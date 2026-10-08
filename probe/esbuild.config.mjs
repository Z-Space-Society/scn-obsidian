import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

// Follows obsidian-sample-plugin: one CommonJS main.js, which is all Obsidian
// downloads. Automerge's WASM rides inside it as base64.
const prod = process.argv[2] === 'production';

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', ...builtinModules],
	format: 'cjs',
	target: 'es2021',
	platform: 'browser',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
