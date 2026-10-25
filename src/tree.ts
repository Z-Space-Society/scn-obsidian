// The relay's tree: every folder document walked from the vault's root,
// giving the path of every note.

import { FOLDER, entriesOf, isFolder } from "./schema.ts";

// A document's contents, or null when the relay could not supply it.
export type Open = (url: string) => Promise<unknown | null>;

export interface Tree {
	// Vault path to note document URL.
	notes: Map<string, string>;
	// Vault path to folder document URL. The root is "".
	folders: Map<string, string>;
	// Paths left out, and why, to be reported.
	skipped: string[];
}

export function join(folder: string, name: string): string {
	return folder === "" ? name : `${folder}/${name}`;
}

export async function walk(open: Open, rootUrl: string): Promise<Tree> {
	const tree: Tree = { notes: new Map(), folders: new Map(), skipped: [] };
	// A document is placed once. A folder seen twice would loop, and a note
	// at two paths is a move in progress (T2), never two files.
	const placed = new Set<string>([rootUrl]);

	async function visit(path: string, url: string) {
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
		const subfolders: Promise<void>[] = [];
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (placed.has(entry.url)) {
				tree.skipped.push(`${child}: already at another path`);
				continue;
			}
			placed.add(entry.url);
			if (entry.type === FOLDER) subfolders.push(visit(child, entry.url));
			else tree.notes.set(child, entry.url);
		}
		await Promise.all(subfolders);
	}

	await visit("", rootUrl);
	return tree;
}
