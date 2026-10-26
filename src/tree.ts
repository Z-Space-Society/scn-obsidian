// The relay's tree: every folder document walked from the vault's root,
// giving the path of every note.

import { FOLDER, entriesOf, isFolder } from "./schema.ts";

// A document's contents, or null when the relay could not supply it.
export type Open = (url: string) => Promise<unknown | null>;

export interface Tree {
	// Vault path to note document URL. A note at two paths, which is a move
	// in progress (T2), is here once, at the path that sorts first.
	notes: Map<string, string>;
	// Every further path a note was found at.
	duplicates: Array<{ path: string; url: string }>;
	// Vault path to folder document URL. The root is "".
	folders: Map<string, string>;
	// Paths left out, and why, to be reported.
	skipped: string[];
}

export function join(folder: string, name: string): string {
	return folder === "" ? name : `${folder}/${name}`;
}

export function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

export function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

// `path` itself, or anything under it.
export function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

export async function walk(open: Open, rootUrl: string): Promise<Tree> {
	const tree: Tree = { notes: new Map(), duplicates: [], folders: new Map(), skipped: [] };
	const found: Array<{ path: string; url: string }> = [];

	// A folder is walked at every path it is found at, so one being moved is
	// seen at both. Only a folder inside itself is refused, which would loop.
	async function visit(path: string, url: string, ancestors: Set<string>) {
		const doc = await open(url);
		if (doc === null) {
			tree.skipped.push(`${path || "the vault root"}: not available from the relay`);
			return;
		}
		if (!isFolder(doc)) {
			tree.skipped.push(`${path || "the vault root"}: not a folder document`);
			return;
		}
		tree.folders.set(path, url);
		const { entries, skipped } = entriesOf(doc);
		for (const entry of skipped) tree.skipped.push(`${join(path, entry.name)}: name not usable here`);
		const inside = new Set(ancestors).add(url);
		const subfolders: Promise<void>[] = [];
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.type !== FOLDER) found.push({ path: child, url: entry.url });
			else if (inside.has(entry.url)) tree.skipped.push(`${child}: a folder inside itself`);
			else subfolders.push(visit(child, entry.url, inside));
		}
		await Promise.all(subfolders);
	}

	await visit("", rootUrl, new Set());
	found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const placed = new Set<string>();
	for (const { path, url } of found) {
		if (placed.has(url)) {
			tree.duplicates.push({ path, url });
		} else {
			placed.add(url);
			tree.notes.set(path, url);
		}
	}
	return tree;
}
