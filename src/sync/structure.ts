// Edits to folder documents, and the shapes of new documents (spec D1, D2,
// T1 to T3). Strings are written as plain strings, which Automerge 3 stores
// as text objects, as the relay does.

import { NOTE, FOLDER, nameKey, str, type FolderDoc } from "../schema.ts";

export type EntryType = typeof NOTE | typeof FOLDER;

interface EntryFields {
	name: unknown;
	type: unknown;
	url: unknown;
}

export function newFolder(title: string) {
	return { "@patchwork": { type: "folder" }, title, docs: [] as EntryFields[] };
}

export function newNote(name: string, content: string) {
	return { "@patchwork": { type: "file" }, name, extension: NOTE, mimeType: "text/markdown", content };
}

function docsOf(doc: FolderDoc): EntryFields[] {
	if (!Array.isArray(doc.docs)) (doc as { docs: EntryFields[] }).docs = [];
	return doc.docs as EntryFields[];
}

function indexOf(doc: FolderDoc, url: string): number {
	return docsOf(doc).findIndex((entry) => str(entry.url) === url);
}

// Whether `name` would collide (D5) with an entry for another document.
export function collides(doc: FolderDoc, name: string, url: string | null): boolean {
	const key = nameKey(name);
	return docsOf(doc).some((entry) => {
		const other = str(entry.name);
		return other !== null && nameKey(other) === key && str(entry.url) !== url;
	});
}

export function addEntry(doc: FolderDoc, name: string, type: EntryType, url: string) {
	docsOf(doc).push({ name, type, url });
}

// T1. One change to one document, so no device sees the note at two paths.
export function renameEntry(doc: FolderDoc, url: string, name: string): boolean {
	const index = indexOf(doc, url);
	if (index === -1) return false;
	docsOf(doc)[index].name = name;
	return true;
}

// T3. Every entry for the document goes, in case a duplicate was left.
export function removeEntry(doc: FolderDoc, url: string): boolean {
	const docs = docsOf(doc) as EntryFields[] & { deleteAt(index: number): void };
	let removed = false;
	for (let index = docs.length - 1; index >= 0; index--) {
		if (str(docs[index].url) === url) {
			docs.deleteAt(index);
			removed = true;
		}
	}
	return removed;
}
