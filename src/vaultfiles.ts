// Files through Obsidian's Vault API, which does not expose hidden folders.

import type { App } from "obsidian";
import type { Files } from "./notes.ts";

export class VaultFiles implements Files {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	// "What syncs": markdown only, never the config folder, never a path
	// with a dot-prefixed segment. The Vault API already hides those; this is
	// the second wall.
	synced(path: string): boolean {
		const { configDir } = this.app.vault;
		return (
			path.toLowerCase().endsWith(".md") &&
			path !== configDir &&
			!path.startsWith(`${configDir}/`) &&
			!path.split("/").some((segment) => segment.startsWith("."))
		);
	}

	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.read(file) : null;
	}

	async write(path: string, text: string) {
		if (!this.synced(path)) throw new Error(`${path} is not a path SCN Sync writes`);
		const { vault } = this.app;
		const file = vault.getFileByPath(path);
		if (file) {
			await vault.process(file, () => text);
			return;
		}
		const segments = path.split("/").slice(0, -1);
		for (let i = 1; i <= segments.length; i++) {
			const folder = segments.slice(0, i).join("/");
			if (!vault.getFolderByPath(folder)) await vault.createFolder(folder);
		}
		await vault.create(path, text);
	}

	list(): string[] {
		return this.app.vault
			.getMarkdownFiles()
			.map((file) => file.path)
			.filter((path) => this.synced(path));
	}
}
