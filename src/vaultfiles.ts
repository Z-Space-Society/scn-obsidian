// Files through Obsidian's Vault API, which does not expose hidden folders.
// A note open in an editor is read and written through the editor (O5): its
// buffer holds keystrokes not yet saved, and a write to the file under it
// would lose the cursor and can lose those keystrokes.

import { MarkdownView, type App, type Editor } from "obsidian";
import { splicesBetween } from "./diff.ts";
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

	// The editor of the first open view of this note, if any.
	editorFor(path: string): Editor | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return view.editor;
		}
		return null;
	}

	async read(path: string): Promise<string | null> {
		const editor = this.editorFor(path);
		if (editor) return editor.getValue();
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.read(file) : null;
	}

	async write(path: string, text: string, expected?: string | null): Promise<boolean> {
		if (!this.synced(path)) throw new Error(`${path} is not a path SCN Sync writes`);
		const { vault } = this.app;

		const editor = this.editorFor(path);
		if (editor) {
			const current = editor.getValue();
			if (expected !== undefined && current !== expected) return false;
			// Smallest changes, last first, so the cursor and selection map
			// through each one. Obsidian saves the buffer to disk afterwards.
			for (const { index, remove, insert } of splicesBetween(current, text)) {
				editor.replaceRange(insert, editor.offsetToPos(index), editor.offsetToPos(index + remove));
			}
			return true;
		}

		const file = vault.getFileByPath(path);
		if (file) {
			let wrote = false;
			await vault.process(file, (data) => {
				if (expected !== undefined && data !== expected) return data;
				wrote = true;
				return text;
			});
			return wrote;
		}
		if (expected !== undefined && expected !== null) return false;
		await this.makeParents(path);
		await vault.create(path, text);
		return true;
	}

	private async makeParents(path: string) {
		const { vault } = this.app;
		const segments = path.split("/").slice(0, -1);
		for (let i = 1; i <= segments.length; i++) {
			const folder = segments.slice(0, i).join("/");
			if (!vault.getFolderByPath(folder)) await vault.createFolder(folder);
		}
	}

	// vault.rename, not fileManager.renameFile: the second rewrites links in
	// other notes, and two devices following one rename would both do it.
	async rename(from: string, to: string): Promise<boolean> {
		const { vault } = this.app;
		const item = vault.getAbstractFileByPath(from);
		if (!item || vault.getAbstractFileByPath(to)) return false;
		await this.makeParents(to);
		await vault.rename(item, to);
		return true;
	}

	async trash(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	hasFolder(path: string): boolean {
		return this.app.vault.getFolderByPath(path) !== null;
	}

	// Read from disk: Obsidian's own list of a folder's children catches up
	// with a file just trashed only later, so the folder would look full.
	// Removed only once seen empty. A non-recursive rmdir is a plain file
	// delete on desktop, which a folder refuses (EISDIR).
	async removeFolderIfEmpty(path: string) {
		const { adapter } = this.app.vault;
		if (path === "" || !(await adapter.exists(path))) return;
		const listed = await adapter.list(path);
		if (listed.files.length > 0 || listed.folders.length > 0) return;
		await adapter.rmdir(path, true);
	}

	list(): string[] {
		return this.app.vault
			.getMarkdownFiles()
			.map((file) => file.path)
			.filter((path) => this.synced(path));
	}
}
