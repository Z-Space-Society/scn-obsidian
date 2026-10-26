// Per-note sync state, spec L2, and the file access the sync works through.
// Both are interfaces so the sync runs under `node --test` against memory.

export interface NoteState {
	path: string;
	url: string;
	// SHA-256 of the text last written to, or read from, the file.
	syncedHash: string;
	// The document's heads at that moment. With syncedHash, the base (O2).
	syncedHeads: string[];
	// T5. Not set by anything yet.
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
	// Whether a path is one the sync acts on: markdown, and no dot-prefixed
	// segment, which covers the config folder and the trash.
	synced(path: string): boolean;
}

export class MemoryFiles implements Files {
	files = new Map<string, string>();

	async read(path: string) {
		return this.files.get(path) ?? null;
	}

	async write(path: string, text: string, expected?: string | null) {
		if (expected !== undefined && (this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, text);
		return true;
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
