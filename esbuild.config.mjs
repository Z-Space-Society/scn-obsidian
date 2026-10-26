import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

// Follows obsidian-sample-plugin: one CommonJS main.js, which is all Obsidian
// downloads.
const prod = process.argv[2] === 'production';

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', ...builtinModules],
	// cbor-x's own build without eval: the default compiles readers with
	// new Function, which the community directory's scan flags.
	alias: { 'cbor-x': 'cbor-x/index-no-eval' },
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
