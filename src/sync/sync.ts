// Between the relay and the files: connect (V3), inbound (O4), outbound (O3),
// and the structure changes made in this vault (T1 to T3, this vault's side).
// Following another device's renames, moves and deletes is not built yet.

import * as A from "@automerge/automerge/slim";
import type { AutomergeUrl, DocHandle, Repo, UrlHeads } from "@automerge/automerge-repo/slim";
import { splicesBetween } from "../diff.ts";
import { type Files, type NoteState, type NoteStore, sha256 } from "../notes.ts";
import { FOLDER, NOTE, nameKey, noteText, validName, type FolderDoc } from "../schema.ts";
import { type Tree, nameOf, parentOf, walk, within } from "../tree.ts";
import { addEntry, collides, newFolder, newNote, removeEntry, renameEntry, type EntryType } from "./structure.ts";

// Obsidian reports a folder's rename or delete as one event or many, in an
// order it does not promise. Events this close together are handled as one
// batch, folders first.
export const EVENT_BATCH_MS = 50;

// What the connect procedure will do, shown to the member before it runs.
export interface Plan {
	// No local file: written from the relay.
	download: string[];
	// The local file already matches: nothing written.
	adopt: string[];
	// The local file differs: kept under a new name, then written.
	copy: string[];
	// Local notes the relay does not have: uploaded.
	localOnly: string[];
}

export interface SyncOptions {
	repo: Repo;
	rootUrl: string;
	files: Files;
	store: NoteStore;
	// False means the member declined, and nothing is written.
	confirm: (plan: Plan) => Promise<boolean>;
	onStatus: () => void;
	// For copy names, YYYY-MM-DD.
	today: () => string;
}

type StructureEvent =
	| { kind: "create"; path: string }
	| { kind: "delete"; path: string; folder: boolean }
	| { kind: "rename"; from: string; to: string; folder: boolean };

// `<name> (local copy <date>).md`, beside the original.
export function copyName(path: string, date: string, n = 1): string {
	const slash = path.lastIndexOf("/");
	const base = path.slice(slash + 1).replace(/\.md$/i, "");
	const suffix = n === 1 ? "" : ` ${n}`;
	return `${path.slice(0, slash + 1)}${base} (local copy ${date}${suffix}).md`;
}

function sameHeads(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function depth(path: string): number {
	return path.split("/").length;
}

// A path under `from`, moved to the same place under `to`.
function moved(path: string, from: string, to: string): string {
	return to + path.slice(from.length);
}

class Refused extends Error {}

export class Sync {
	// Notes not syncing, and why.
	notSynced = new Map<string, string>();
	// Paths in the relay's tree that are left out, and why.
	skipped: string[] = [];
	// True once the connect procedure has run for this store.
	connected = false;
	declined = false;

	private options: SyncOptions;
	private tree: Tree | null = null;
	// Every path a note is at, duplicates included, and each note's path.
	private paths = new Map<string, string>();
	private pathOf = new Map<string, string>();
	private states = new Map<string, NoteState>();
	private handles = new Map<string, DocHandle<unknown>>();
	private queues = new Map<string, Promise<void>>();
	private pending = new Set<string>();
	private walking: Promise<void> | null = null;
	// Whether the first walk since start has looked at every note's file.
	private swept = false;
	private walkAgain = false;
	// Bumped by every structure change made here. A walk that began before
	// one could still show the old paths, and is thrown away.
	private structureVersion = 0;
	private structureQueue: Promise<void> = Promise.resolve();
	private structureBusy = 0;
	private events: StructureEvent[] = [];
	private eventTimer: ReturnType<typeof setTimeout> | null = null;
	private busy = 0;
	private stopped = false;

	constructor(options: SyncOptions) {
		this.options = options;
	}

	get working(): boolean {
		return this.busy > 0;
	}

	// Notes here that the relay does not have yet.
	unsent(): string[] {
		if (!this.connected) return [];
		return this.options.files.list().filter((path) => !this.states.has(path));
	}

	// L3: a store with no records runs the connect procedure, whether this
	// is the first connect or IndexedDB was lost.
	async start() {
		for (const state of await this.options.store.all()) this.states.set(state.path, state);
		this.connected = this.states.size > 0;
		await this.refresh();
	}

	stop() {
		this.stopped = true;
		if (this.eventTimer !== null) clearTimeout(this.eventTimer);
	}

	// Waits until nothing is queued, for tests and for a status that settles.
	async idle() {
		while (this.walking || this.queues.size > 0 || this.eventTimer !== null || this.structureBusy > 0) {
			if (this.eventTimer !== null) await new Promise((resolve) => setTimeout(resolve, EVENT_BATCH_MS));
			await Promise.all([this.walking, this.structureQueue, ...this.queues.values()]);
		}
	}

	// N3. A document syncs only while it has an open handle, so every folder
	// and note in the tree is opened and kept.
	private async open(url: string): Promise<unknown | null> {
		let handle = this.handles.get(url);
		if (!handle) {
			const found = await this.options.repo.find<unknown>(url as AutomergeUrl, {
				allowableStates: ["ready", "unavailable"],
			});
			handle = this.handles.get(url) ?? this.watch(found);
		}
		return handle.isReady() ? handle.doc() : null;
	}

	private watch(handle: DocHandle<unknown>): DocHandle<unknown> {
		const url = handle.url;
		this.handles.set(url, handle);
		// An unavailable document can arrive later, when a peer has it. Its
		// first change comes just before it turns ready, and whenReady gives
		// up after a while, so each arrival is waited for afresh.
		const arrived = (h: DocHandle<unknown>) => {
			if (h.isReady()) this.changed(url);
			else h.whenReady().then(() => this.changed(url), () => {});
		};
		handle.on("change", ({ handle: h }) => arrived(h));
		arrived(handle);
		return handle;
	}

	private changed(url: string) {
		if (this.stopped) return;
		const path = this.pathOf.get(url);
		if (path === undefined) void this.refresh();
		else this.schedule(path);
	}

	// Walks the tree again, once at a time: a change that arrives during a
	// walk causes one more walk after it.
	private refresh(): Promise<void> {
		this.walkAgain = true;
		if (this.stopped) return Promise.resolve();
		this.walking ??= this.walkLoop();
		return this.walking;
	}

	// The loop's last check and the clearing of `walking` happen in one
	// synchronous step, so a request made in between cannot be lost.
	private async walkLoop() {
		await Promise.resolve();
		try {
			while (this.walkAgain && !this.stopped) {
				this.walkAgain = false;
				try {
					await this.walkOnce();
				} catch (e) {
					console.error("SCN Sync: walking the vault failed", e);
				}
			}
		} finally {
			this.walking = null;
			this.options.onStatus();
		}
	}

	private async walkOnce() {
		this.busy++;
		this.options.onStatus();
		try {
			// Never alongside a structure change: one half done would show.
			await this.structureQueue;
			const version = this.structureVersion;
			const tree = await walk((url) => this.open(url), this.options.rootUrl);
			if (this.structureVersion !== version) {
				this.walkAgain = true;
				return;
			}
			this.skipped = tree.skipped;
			// The root is not available yet. Its handle calls back when it is.
			if (!tree.folders.has("")) return;
			this.useTree(tree);
			await Promise.all([...this.paths.values()].map((url) => this.open(url)));
			if (this.stopped || this.declined) return;
			if (!this.connected) await this.connect(tree);
			if (!this.connected) return;
			this.finishMoves(tree);
			// The first time, every note: a file edited while Obsidian was
			// closed shows only in its hash. After that, only documents that
			// moved on; file changes arrive as events.
			if (this.swept) this.scheduleChanged();
			else for (const path of this.paths.keys()) this.schedule(path);
			if (!this.swept) this.uploadNew();
			this.swept = true;
		} finally {
			this.busy--;
		}
	}

	private useTree(tree: Tree) {
		this.tree = tree;
		this.paths = new Map(tree.notes);
		for (const { path, url } of tree.duplicates) this.paths.set(path, url);
		this.pathOf = new Map();
		for (const [path, url] of tree.notes) this.pathOf.set(url, path);
		// A note at two paths syncs at the one this vault has it at.
		for (const state of this.states.values()) {
			if (this.paths.get(state.path) === state.url) this.pathOf.set(state.url, state.path);
		}
		const local = new Set(this.options.files.list());
		for (const path of this.notSynced.keys()) {
			if (!this.paths.has(path) && !local.has(path)) this.notSynced.delete(path);
		}
	}

	// Every note whose document has moved on since it was last written.
	private scheduleChanged() {
		for (const [path, url] of this.paths) {
			const state = this.states.get(path);
			const handle = this.handles.get(url);
			if (!state || !handle?.isReady() || !sameHeads(handle.heads(), state.syncedHeads)) this.schedule(path);
		}
	}

	// V3. Nothing here deletes or overwrites a local file without a copy.
	private async connect(tree: Tree) {
		const { files } = this.options;
		const plan: Plan = { download: [], adopt: [], copy: [], localOnly: [] };
		const found = new Map<string, { url: string; text: string; heads: string[] }>();
		for (const [path, url] of tree.notes) {
			const handle = this.handles.get(url);
			const text = handle?.isReady() ? noteText(handle.doc()) : null;
			// Not available yet. Inbound writes it when it arrives.
			if (!handle || text === null) continue;
			found.set(path, { url, text, heads: handle.heads() });
			const local = await files.read(path);
			if (local === null) plan.download.push(path);
			else if (local === text) plan.adopt.push(path);
			else plan.copy.push(path);
		}
		plan.localOnly = files.list().filter((path) => !tree.notes.has(path));

		if (!(await this.options.confirm(plan))) {
			this.declined = true;
			return;
		}
		for (const path of plan.copy) {
			const local = await files.read(path);
			if (local === null) continue;
			let n = 1;
			while ((await files.read(copyName(path, this.options.today(), n))) !== null) n++;
			await files.write(copyName(path, this.options.today(), n), local);
		}
		for (const [path, { url, text, heads }] of found) {
			if (!plan.adopt.includes(path)) await files.write(path, text);
			await this.record(path, url, text, heads);
		}
		this.connected = true;
	}

	// A file was saved, or an open note typed in.
	fileChanged(path: string) {
		if (this.stopped || !this.connected || !this.states.has(path)) return;
		this.schedule(path);
	}

	// All work for one note runs through one queue, and a burst of changes
	// that arrives while a write waits produces one write.
	private schedule(path: string) {
		if (this.pending.has(path)) return;
		this.pending.add(path);
		this.busy++;
		const previous = this.queues.get(path) ?? Promise.resolve();
		const next = previous
			.then(() => {
				this.pending.delete(path);
				return this.syncNote(path);
			})
			.catch((e) => console.error(`SCN Sync: ${path} failed`, e))
			.finally(() => {
				this.busy--;
				if (this.queues.get(path) === next) this.queues.delete(path);
				this.options.onStatus();
			});
		this.queues.set(path, next);
	}

	// The one task for a note, whatever caused it. The file is compared with
	// what was last synced (syncedHash) and the document with where it was
	// (syncedHeads): an edited file goes out, merging whatever came in, and an
	// unedited one takes the document's text.
	private async syncNote(path: string) {
		if (!this.connected || this.stopped || !this.tree) return;
		const { files } = this.options;
		const url = this.paths.get(path);
		if (url === undefined) return;
		const handle = this.handles.get(url);
		if (!handle?.isReady()) return;
		const text = noteText(handle.doc());
		if (text === null) {
			this.notSynced.set(path, "Not a note SCN Sync can read.");
			return;
		}
		const state = this.states.get(path);
		const elsewhere = [...this.states.values()].find((s) => s.url === url && s.path !== path);
		if (elsewhere) {
			// This vault has the note at another path: a move in progress, or
			// one made on another device, which is not followed yet.
			if (!state && this.paths.get(elsewhere.path) !== url) {
				this.notSynced.set(path, `Moved from ${elsewhere.path} on another device. Moves are not followed yet.`);
			}
			return;
		}
		const local = await files.read(path);

		if (!state) {
			if (local !== null && local !== text) {
				this.notSynced.set(path, "A different note with this name is already here.");
				return;
			}
			await this.writeThenRecord(path, url, text, local, handle);
			return;
		}
		if (local === null) {
			this.notSynced.set(path, "Deleted here while SCN Sync was not running. Not sent yet.");
			return;
		}
		if ((await sha256(local)) === state.syncedHash) {
			// O4, and O7: the plugin's own write coming back stops here.
			if (sameHeads(handle.heads(), state.syncedHeads)) {
				this.notSynced.delete(path);
				return;
			}
			await this.writeThenRecord(path, url, text, local, handle);
			return;
		}
		const merged = this.outbound(handle, state, local);
		if (merged === null) {
			this.notSynced.set(path, "Its last synced version could not be read.");
			return;
		}
		await this.writeThenRecord(path, url, merged, local, handle);
	}

	// O3. Diff against the base and apply at the base (O2), never against the
	// document's current text, where a change that arrived since would look
	// like something the member deleted. Returns the merged text.
	private outbound(handle: DocHandle<unknown>, state: NoteState, local: string): string | null {
		const base = state.syncedHeads as UrlHeads;
		const baseText = noteText(handle.view(base).doc());
		if (baseText === null) return null;
		const splices = splicesBetween(baseText, local);
		if (splices.length > 0) {
			handle.changeAt(base, (doc) => {
				for (const { index, remove, insert } of splices) {
					A.splice(doc as A.Doc<unknown>, ["content"], index, remove, insert);
				}
			});
		}
		return noteText(handle.doc());
	}

	// Writes `text` over a file that still holds `local`, then records it. A
	// file that changed meanwhile, as an open note being typed in does, is
	// left alone and the note queued again.
	private async writeThenRecord(path: string, url: string, text: string, local: string | null, handle: DocHandle<unknown>) {
		if (local !== text && !(await this.options.files.write(path, text, local))) {
			this.schedule(path);
			return;
		}
		await this.record(path, url, text, handle.heads());
		this.notSynced.delete(path);
	}

	private async record(path: string, url: string, text: string, heads: string[]) {
		const state: NoteState = {
			path,
			url,
			syncedHash: await sha256(text),
			syncedHeads: heads,
			offlineEdit: false,
			movedFrom: this.states.get(path)?.movedFrom,
		};
		this.states.set(path, state);
		await this.options.store.put(state);
	}

	// --- Structure changes made in this vault ------------------------------

	created(path: string) {
		this.queueEvent({ kind: "create", path });
	}

	deleted(path: string, folder: boolean) {
		this.queueEvent({ kind: "delete", path, folder });
	}

	renamed(from: string, to: string, folder: boolean) {
		this.queueEvent({ kind: "rename", from, to, folder });
	}

	private queueEvent(event: StructureEvent) {
		if (this.stopped) return;
		this.events.push(event);
		this.eventTimer ??= setTimeout(() => {
			this.eventTimer = null;
			const batch = this.events;
			this.events = [];
			void this.structure(() => this.applyEvents(batch));
		}, EVENT_BATCH_MS);
	}

	// Structure changes run one at a time, apart from content, each after the
	// content tasks already queued for the paths it touches.
	private structure(task: () => Promise<void>): Promise<void> {
		this.structureBusy++;
		this.busy++;
		const next = this.structureQueue
			.then(task)
			.catch((e) => console.error("SCN Sync: a structure change failed", e))
			.finally(() => {
				this.structureBusy--;
				this.busy--;
				this.options.onStatus();
			});
		this.structureQueue = next;
		return next;
	}

	private async settle(predicate: (path: string) => boolean) {
		await Promise.all([...this.queues].filter(([path]) => predicate(path)).map(([, queue]) => queue));
	}

	private async applyEvents(batch: StructureEvent[]) {
		if (!this.connected || !this.tree || this.stopped) return;
		const { files } = this.options;
		const byDepth = (a: string, b: string) => depth(a) - depth(b);

		// Folders first, shallowest first. What a folder event covers, its
		// children's events do not do again.
		const covered: Array<{ from: string; to: string | null }> = [];
		const isCovered = (from: string, to: string | null) =>
			covered.some((c) => within(from, c.from) && (c.to === null ? to === null : to === moved(from, c.from, c.to)));

		for (const event of batch.filter((e) => e.kind === "rename" && e.folder).sort((a, b) => byDepth((a as { from: string }).from, (b as { from: string }).from))) {
			const { from, to } = event as { from: string; to: string };
			if (isCovered(from, to)) continue;
			if (await this.moveFolder(from, to)) covered.push({ from, to });
		}
		for (const event of batch.filter((e) => e.kind === "delete" && e.folder).sort((a, b) => byDepth((a as { path: string }).path, (b as { path: string }).path))) {
			const { path } = event as { path: string };
			if (isCovered(path, null)) continue;
			if (await this.removeFolder(path)) covered.push({ from: path, to: null });
		}
		for (const event of batch) {
			if (event.kind === "rename" && !event.folder) {
				if (isCovered(event.from, event.to)) continue;
				const kept = files.synced(event.to);
				if (this.states.has(event.from) && kept) await this.moveNote(event.from, event.to);
				else if (this.states.has(event.from)) await this.removeNote(event.from);
			} else if (event.kind === "delete" && !event.folder) {
				if (isCovered(event.path, null)) continue;
				if (this.states.has(event.path)) await this.removeNote(event.path);
			}
		}
		// Creates, and anything renamed into what syncs: every note here the
		// relay does not have.
		await this.createNotes(this.newPaths());
	}

	// Local notes with no state and no entry: new, so uploaded.
	private newPaths(): string[] {
		return this.unsent().filter((path) => !this.paths.has(path));
	}

	private uploadNew() {
		void this.structure(() => this.createNotes(this.newPaths()));
	}

	private folderHandle(path: string): DocHandle<FolderDoc> | null {
		const url = this.tree?.folders.get(path);
		const handle = url ? this.handles.get(url) : undefined;
		return handle?.isReady() ? (handle as DocHandle<FolderDoc>) : null;
	}

	// The folder document at `path`, made with its parents if need be.
	private async ensureFolder(path: string): Promise<DocHandle<FolderDoc>> {
		const existing = this.folderHandle(path);
		if (existing) return existing;
		// On the relay but not loaded: making another would duplicate it.
		if (this.tree?.folders.has(path)) throw new Refused("Its folder is not available from SCN yet.");
		const name = nameOf(path);
		if (!validName(name)) throw new Refused(`The folder name "${name}" is not synced.`);
		const parent = await this.ensureFolder(parentOf(path));
		if (collides(parent.doc(), name, null)) throw new Refused(`A note or folder named "${name}" is already on SCN.`);
		const handle = this.options.repo.create(newFolder(name)) as DocHandle<unknown>;
		this.watch(handle);
		parent.change((doc) => addEntry(doc, name, FOLDER, handle.url));
		this.tree!.folders.set(path, handle.url);
		this.structureVersion++;
		return handle as DocHandle<FolderDoc>;
	}

	// O3, a new file. Note documents first, then their entries, one change
	// per folder however many notes land in it.
	private async createNotes(paths: string[]) {
		if (paths.length === 0) return;
		const { files, repo } = this.options;
		const byFolder = new Map<string, Array<{ path: string; text: string; handle: DocHandle<unknown> }>>();
		for (const path of paths) {
			const name = nameOf(path);
			try {
				if (!path.split("/").every(validName)) throw new Refused("Its name is not synced.");
				const folder = await this.ensureFolder(parentOf(path));
				const siblings = byFolder.get(parentOf(path)) ?? [];
				if (collides(folder.doc(), name, null) || siblings.some((s) => nameKey(nameOf(s.path)) === nameKey(name))) {
					throw new Refused("A note with this name is already on SCN.");
				}
				const text = await files.read(path);
				if (text === null) continue;
				const handle = repo.create(newNote(name, text)) as DocHandle<unknown>;
				this.watch(handle);
				byFolder.set(parentOf(path), [...siblings, { path, text, handle }]);
			} catch (e) {
				if (!(e instanceof Refused)) throw e;
				this.notSynced.set(path, e.message);
			}
		}
		for (const [folderPath, notes] of byFolder) {
			const folder = this.folderHandle(folderPath)!;
			folder.change((doc) => {
				for (const { path, handle } of notes) addEntry(doc, nameOf(path), NOTE, handle.url);
			});
			for (const { path, text, handle } of notes) {
				this.paths.set(path, handle.url);
				this.pathOf.set(handle.url, path);
				this.tree!.notes.set(path, handle.url);
				await this.record(path, handle.url, text, handle.heads());
				this.notSynced.delete(path);
				// An edit saved while it was being created.
				this.schedule(path);
			}
		}
		this.structureVersion++;
	}

	// T1 within a folder, T2 between folders: add to the destination first,
	// then remove from the source. `beforeAdd` runs before the add.
	private async moveEntry(url: string, type: EntryType, from: string, to: string, beforeAdd: () => Promise<void>): Promise<boolean> {
		const name = nameOf(to);
		if (!validName(name)) throw new Refused("Its new name is not synced.");
		const source = this.folderHandle(parentOf(from));
		if (!source) return false;
		this.structureVersion++;
		if (parentOf(from) === parentOf(to)) {
			if (collides(source.doc(), name, url)) throw new Refused("A note or folder with this name is already on SCN.");
			await beforeAdd();
			source.change((doc) => renameEntry(doc, url, name));
			return true;
		}
		const destination = await this.ensureFolder(parentOf(to));
		if (collides(destination.doc(), name, url)) throw new Refused("A note or folder with this name is already on SCN.");
		await beforeAdd();
		destination.change((doc) => addEntry(doc, name, type, url));
		source.change((doc) => removeEntry(doc, url));
		return true;
	}

	private async moveNote(from: string, to: string) {
		const state = this.states.get(from)!;
		await this.settle((path) => path === from || path === to);
		try {
			const across = parentOf(from) !== parentOf(to);
			const done = await this.moveEntry(state.url, NOTE, from, to, async () => {
				// The state goes first, marked, so a move cut short is finished
				// at the next start rather than left at two paths.
				await this.moveState(from, to, across ? from : undefined);
			});
			if (!done) return;
			if (across) await this.moveState(to, to, undefined);
			this.paths.delete(from);
			this.paths.set(to, state.url);
			this.pathOf.set(state.url, to);
		} catch (e) {
			if (!(e instanceof Refused)) throw e;
			this.notSynced.set(to, e.message);
		}
	}

	private async moveState(from: string, to: string, movedFrom: string | undefined) {
		const state = this.states.get(from);
		if (!state) return;
		const next = { ...state, path: to, movedFrom };
		this.states.delete(from);
		this.states.set(to, next);
		if (from !== to) await this.options.store.delete(from);
		await this.options.store.put(next);
	}

	// A folder's entry moves, and every note under it with it. No note
	// document changes.
	private async moveFolder(from: string, to: string): Promise<boolean> {
		const url = this.tree?.folders.get(from);
		if (!url || from === "") return false;
		await this.settle((path) => within(path, from) || within(path, to));
		try {
			const done = await this.moveEntry(url, FOLDER, from, to, async () => {
				for (const path of [...this.states.keys()].filter((p) => within(p, from))) {
					await this.moveState(path, moved(path, from, to), undefined);
				}
			});
			if (!done) return false;
		} catch (e) {
			if (!(e instanceof Refused)) throw e;
			this.notSynced.set(to, e.message);
			return false;
		}
		const tree = this.tree!;
		for (const [path, folderUrl] of [...tree.folders]) {
			if (!within(path, from)) continue;
			tree.folders.delete(path);
			tree.folders.set(moved(path, from, to), folderUrl);
		}
		for (const [path, noteUrl] of [...this.paths]) {
			if (!within(path, from)) continue;
			this.paths.delete(path);
			this.paths.set(moved(path, from, to), noteUrl);
			this.pathOf.set(noteUrl, moved(path, from, to));
		}
		return true;
	}

	// T3, this vault's side. The note's document stays on the relay, and
	// nothing leads to it.
	private async removeNote(path: string) {
		const state = this.states.get(path)!;
		await this.settle((p) => p === path);
		const folder = this.folderHandle(parentOf(path));
		this.structureVersion++;
		folder?.change((doc) => removeEntry(doc, state.url));
		await this.dropState(path);
	}

	private async removeFolder(path: string): Promise<boolean> {
		const url = this.tree?.folders.get(path);
		if (!url || path === "") return false;
		await this.settle((p) => within(p, path));
		const parent = this.folderHandle(parentOf(path));
		this.structureVersion++;
		parent?.change((doc) => removeEntry(doc, url));
		for (const p of [...this.states.keys()].filter((p) => within(p, path))) await this.dropState(p);
		for (const p of [...this.tree!.folders.keys()].filter((p) => within(p, path))) this.tree!.folders.delete(p);
		return true;
	}

	private async dropState(path: string) {
		const state = this.states.get(path);
		this.states.delete(path);
		this.paths.delete(path);
		this.notSynced.delete(path);
		if (state && this.pathOf.get(state.url) === path) this.pathOf.delete(state.url);
		await this.options.store.delete(path);
	}

	// T2. A move cut short between its add and its remove: this vault has the
	// note at its new path, and the old entry is still there.
	private finishMoves(tree: Tree) {
		for (const state of this.states.values()) {
			const from = state.movedFrom;
			if (from === undefined) continue;
			const still = tree.notes.get(from) === state.url || tree.duplicates.some((d) => d.path === from && d.url === state.url);
			void this.structure(async () => {
				if (still) {
					this.structureVersion++;
					this.folderHandle(parentOf(from))?.change((doc) => removeEntry(doc, state.url));
				}
				await this.moveState(state.path, state.path, undefined);
			});
		}
	}
}
