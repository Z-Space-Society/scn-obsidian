// Per-note sync state, spec L2, and the file access the sync works through.
// Both are interfaces so the sync runs under `node --test` against memory.

export interface NoteState {
	path: string;
	url: string;
	// SHA-256 of the text last written to, or read from, the file.
	syncedHash: string;
	// The document's heads at that moment. With syncedHash, the base (O2).
	syncedHeads: string[];
	// T5. Set by an edit sent with no connection open, until a connection
	// has had time to carry it.
	offlineEdit: boolean;
	// T2. Set on a note moved here from another folder until the old entry
	// is removed, so a move cut short is finished at the next start.
	movedFrom?: string;
}

export interface NoteStore {
	all(): Promise<NoteState[]>;
	put(state: NoteState): Promise<void>;
	delete(path: string): Promise<void>;
}

export class MemoryNoteStore implements NoteStore {
	records = new Map<string, NoteState>();

	async all() {
		return [...this.records.values()];
	}

	async put(state: NoteState) {
		this.records.set(state.path, { ...state });
	}

	async delete(path: string) {
		this.records.delete(path);
	}
}

// The vault's markdown files, by vault path.
export interface Files {
	read(path: string): Promise<string | null>;
	// Creates the file and any missing folders, or replaces its text. With
	// `expected`, only if the file still holds exactly that: false means it
	// changed since it was read, and nothing was written.
	write(path: string, text: string, expected?: string | null): Promise<boolean>;
	// Every markdown file the sync may act on.
	list(): string[];
	// Moves a file or a folder, with everything in it, making missing parent
	// folders. False when nothing is at `from` or something is at `to`.
	rename(from: string, to: string): Promise<boolean>;
	// To the trash, following the member's trash setting.
	trash(path: string): Promise<void>;
	hasFolder(path: string): boolean;
	// Removes the folder only if nothing at all is left in it.
	removeFolderIfEmpty(path: string): Promise<void>;
	// Whether a path is one the sync acts on: markdown, and no dot-prefixed
	// segment, which covers the config folder and the trash.
	synced(path: string): boolean;
}

export class MemoryFiles implements Files {
	files = new Map<string, string>();
	// Folders made or kept explicitly. A folder with files in it exists
	// whether listed here or not.
	folders = new Set<string>();
	trashed: string[] = [];

	async read(path: string) {
		return this.files.get(path) ?? null;
	}

	async write(path: string, text: string, expected?: string | null) {
		if (expected !== undefined && (this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, text);
		this.addParents(path);
		return true;
	}

	private addParents(path: string) {
		const segments = path.split("/").slice(0, -1);
		for (let i = 1; i <= segments.length; i++) this.folders.add(segments.slice(0, i).join("/"));
	}

	private under(folder: string): string[] {
		return [...this.files.keys(), ...this.folders].filter((p) => p.startsWith(`${folder}/`));
	}

	hasFolder(path: string) {
		return this.folders.has(path) || this.under(path).length > 0;
	}

	async rename(from: string, to: string) {
		if (this.files.has(to) || this.hasFolder(to)) return false;
		if (this.files.has(from)) {
			this.files.set(to, this.files.get(from)!);
			this.files.delete(from);
			this.addParents(to);
			return true;
		}
		if (!this.hasFolder(from)) return false;
		for (const path of [...this.files.keys()].filter((p) => p.startsWith(`${from}/`))) {
			this.files.set(to + path.slice(from.length), this.files.get(path)!);
			this.files.delete(path);
		}
		for (const path of [...this.folders].filter((p) => p === from || p.startsWith(`${from}/`))) {
			this.folders.delete(path);
			this.folders.add(to + path.slice(from.length));
		}
		this.addParents(`${to}/x`);
		return true;
	}

	async trash(path: string) {
		if (this.files.delete(path)) this.trashed.push(path);
	}

	async removeFolderIfEmpty(path: string) {
		if (this.under(path).length === 0) this.folders.delete(path);
	}

	list() {
		return [...this.files.keys()].filter((path) => this.synced(path));
	}

	synced(path: string) {
		return path.toLowerCase().endsWith(".md") && !path.split("/").some((segment) => segment.startsWith("."));
	}
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
