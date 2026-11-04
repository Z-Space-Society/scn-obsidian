// M3. One vault's folder, as its sync engine sees it.
//
// Each SCN vault syncs through its own `Sync`, which works in paths relative
// to the vault's root. This hands it a `Files` whose root is the vault's
// folder, so `Private/Notes/plan.md` reaches it as `plan.md`, and it sees
// nothing outside the folder. Paths in its note store are relative too, which
// is why a vault's folder can be renamed without touching the store.

import type { Files } from "./notes.ts";

export class ScopedFiles implements Files {
	private base: Files;
	readonly folder: string;

	constructor(base: Files, folder: string) {
		this.base = base;
		this.folder = folder;
	}

	private full(path: string): string {
		return path === "" ? this.folder : `${this.folder}/${path}`;
	}

	read(path: string) {
		return this.base.read(this.full(path));
	}

	write(path: string, text: string, expected?: string | null) {
		return this.base.write(this.full(path), text, expected);
	}

	list(): string[] {
		const prefix = `${this.folder}/`;
		return this.base
			.list()
			.filter((path) => path.startsWith(prefix))
			.map((path) => path.slice(prefix.length));
	}

	rename(from: string, to: string) {
		return this.base.rename(this.full(from), this.full(to));
	}

	trash(path: string) {
		return this.base.trash(this.full(path));
	}

	hasFolder(path: string) {
		return this.base.hasFolder(this.full(path));
	}

	// The vault's own folder is never removed from here. It goes only when the
	// member leaves the vault, and not even then (M5).
	async removeFolderIfEmpty(path: string) {
		if (path === "") return;
		await this.base.removeFolderIfEmpty(this.full(path));
	}

	synced(path: string) {
		return this.base.synced(this.full(path));
	}
}
