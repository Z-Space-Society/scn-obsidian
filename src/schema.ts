// Document shapes, spec D1 to D5. Reading is lenient: the relay writes every
// string as a text object, which Automerge hands back as a plain string, and
// another writer may use scalar strings, which come back as ImmutableString.

export const FOLDER = "folder";
export const NOTE = "md";

export interface Entry {
	name: string;
	type: string;
	url: string;
}

export interface FolderDoc {
	"@patchwork"?: { type?: unknown };
	title?: unknown;
	docs?: unknown;
}

export interface NoteDoc {
	"@patchwork"?: { type?: unknown };
	name?: unknown;
	extension?: unknown;
	mimeType?: unknown;
	content?: unknown;
}

// A string, whichever way it was stored.
export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	// ImmutableString, without importing Automerge here.
	if (typeof value === "object" && value !== null && typeof (value as { val?: unknown }).val === "string") {
		return (value as { val: string }).val;
	}
	return null;
}

function patchworkType(doc: unknown): string | null {
	if (typeof doc !== "object" || doc === null) return null;
	return str((doc as FolderDoc)["@patchwork"]?.type);
}

export function isFolder(doc: unknown): doc is FolderDoc {
	return patchworkType(doc) === "folder";
}

export function isNote(doc: unknown): doc is NoteDoc {
	return patchworkType(doc) === "file" && str((doc as NoteDoc).extension) === NOTE;
}

// A note's text exactly, or null for a document that is not a note.
export function noteText(doc: unknown): string | null {
	return isNote(doc) ? str(doc.content) : null;
}

// D5. One path segment: not empty, not `.` or `..`, no `/`, no leading dot.
export function validName(name: string): boolean {
	return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.startsWith(".");
}

// D5. Two names collide when they are equal after NFC and case folding, the
// same comparison the relay makes.
export function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

// T4. The name a colliding entry is given, computed from the entry alone so
// every device that sees the collision makes the same edit.
export function conflictName(name: string, type: string, url: string): string {
	const id = url.replace(/^automerge:/, "").slice(0, 6);
	const dot = type === FOLDER ? -1 : name.lastIndexOf(".");
	if (dot <= 0) return `${name} (conflict ${id})`;
	return `${name.slice(0, dot)} (conflict ${id})${name.slice(dot)}`;
}

// The entries of a folder the plugin acts on (D3: folders and notes), with
// collisions resolved the relay's way (D6): the entry whose `url` sorts
// lowest keeps the path. Entries with names not usable here are returned as
// `skipped`, and those that lost a collision as `collisions`, to be renamed.
export function entriesOf(doc: FolderDoc): { entries: Entry[]; skipped: Entry[]; collisions: Entry[] } {
	const raw = Array.isArray(doc.docs) ? doc.docs : [];
	const byKey = new Map<string, Entry>();
	const skipped: Entry[] = [];
	const collisions: Entry[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const fields = item as Record<string, unknown>;
		const name = str(fields.name);
		const type = str(fields.type);
		const url = str(fields.url);
		if (name === null || type === null || url === null) continue;
		if (type !== FOLDER && type !== NOTE) continue;
		const entry = { name: name.normalize("NFC"), type, url };
		if (!validName(entry.name) || (type === NOTE && !entry.name.toLowerCase().endsWith(".md"))) {
			skipped.push(entry);
			continue;
		}
		const key = nameKey(entry.name);
		const held = byKey.get(key);
		if (!held) {
			byKey.set(key, entry);
		} else if (entry.url < held.url) {
			collisions.push(held);
			byKey.set(key, entry);
		} else {
			collisions.push(entry);
		}
	}
	return { entries: [...byKey.values()], skipped, collisions };
}
