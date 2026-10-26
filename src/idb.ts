// The per-note store in IndexedDB, beside the repo's own database (L1).

import type { NoteState, NoteStore } from "./notes.ts";

const STORE = "notes";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

export class IndexedDBNoteStore implements NoteStore {
	private db: Promise<IDBDatabase>;

	constructor(name: string) {
		const open = indexedDB.open(name, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "path" });
		this.db = request(open);
	}

	private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
		return (await this.db).transaction(STORE, mode).objectStore(STORE);
	}

	async all(): Promise<NoteState[]> {
		return request((await this.store("readonly")).getAll() as IDBRequest<NoteState[]>);
	}

	async put(state: NoteState) {
		await request((await this.store("readwrite")).put(state));
	}

	async delete(path: string) {
		await request((await this.store("readwrite")).delete(path));
	}

	async close() {
		(await this.db).close();
	}
}

export function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}
