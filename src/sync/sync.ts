// Between the relay and the files: connect (V3), inbound (O4) and outbound
// (O3) for notes the relay already has. New notes, renames, moves and
// deletes are structure changes, and are not sent yet.

import * as A from "@automerge/automerge/slim";
import type { AutomergeUrl, DocHandle, Repo, UrlHeads } from "@automerge/automerge-repo/slim";
import { splicesBetween } from "../diff.ts";
import { type Files, type NoteState, type NoteStore, sha256 } from "../notes.ts";
import { noteText } from "../schema.ts";
import { type Tree, walk } from "../tree.ts";

// What the connect procedure will do, shown to the member before it runs.
export interface Plan {
	// No local file: written from the relay.
	download: string[];
	// The local file already matches: nothing written.
	adopt: string[];
	// The local file differs: kept under a new name, then written.
	copy: string[];
	// Local notes the relay does not have. Left where they are.
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

export class Sync {
	// Paths the relay has changes for that are held back, and why.
	notSynced = new Map<string, string>();
	// Paths in the relay's tree that are left out, and why.
	skipped: string[] = [];
	// True once the connect procedure has run for this store.
	connected = false;
	declined = false;

	private options: SyncOptions;
	private tree: Tree | null = null;
	private pathOf = new Map<string, string>();
	private states = new Map<string, NoteState>();
	private handles = new Map<string, DocHandle<unknown>>();
	private queues = new Map<string, Promise<void>>();
	private pending = new Set<string>();
	private walking: Promise<void> | null = null;
	// Whether the first walk since start has looked at every note's file.
	private swept = false;
	private walkAgain = false;
	private busy = 0;
	private stopped = false;

	constructor(options: SyncOptions) {
		this.options = options;
	}

	get working(): boolean {
		return this.busy > 0;
	}

	// Notes here that the relay does not have. Nothing sends them yet.
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
	}

	// Waits for every queued note, for tests and for a status that settles.
	async idle() {
		while (this.walking || this.queues.size > 0) {
			await Promise.all([this.walking, ...this.queues.values()]);
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
			handle = this.handles.get(url);
			if (!handle) {
				handle = found;
				this.handles.set(url, handle);
				// An unavailable document can arrive later, when a peer has it.
				// Its first change comes just before it turns ready, and
				// whenReady gives up after a while, so each arrival is waited
				// for afresh.
				const arrived = (h: DocHandle<unknown>) => {
					if (h.isReady()) this.changed(url);
					else h.whenReady().then(() => this.changed(url), () => {});
				};
				handle.on("change", ({ handle: h }) => arrived(h));
				arrived(handle);
			}
		}
		return handle.isReady() ? handle.doc() : null;
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
			const tree = await walk((url) => this.open(url), this.options.rootUrl);
			this.skipped = tree.skipped;
			// The root is not available yet. Its handle calls back when it is.
			if (!tree.folders.has("")) return;
			this.tree = tree;
			this.pathOf = new Map();
			for (const [path, url] of tree.notes) this.pathOf.set(url, path);
			await Promise.all([...tree.notes.values()].map((url) => this.open(url)));
			if (this.stopped || this.declined) return;
			if (!this.connected) await this.connect(tree);
			if (!this.connected) return;
			// The first time, every note: a file edited while Obsidian was
			// closed shows only in its hash. After that, only documents that
			// moved on; file changes arrive as events.
			if (this.swept) this.scheduleChanged(tree);
			else for (const path of tree.notes.keys()) this.schedule(path);
			this.swept = true;
		} finally {
			this.busy--;
		}
	}

	// Every note whose document has moved on since it was last written.
	private scheduleChanged(tree: Tree) {
		for (const [path, url] of tree.notes) {
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

	// A file was saved, or an open note typed in. Only notes the relay
	// already has are sent: a new note is a structure change.
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
		const url = this.tree.notes.get(path);
		// An entry that went away. Deletes and moves are not followed yet.
		if (url === undefined) return;
		const handle = this.handles.get(url);
		if (!handle?.isReady()) return;
		const text = noteText(handle.doc());
		if (text === null) {
			this.notSynced.set(path, "Not a note SCN Sync can read.");
			return;
		}
		const elsewhere = [...this.states.values()].find((s) => s.url === url && s.path !== path);
		if (elsewhere) {
			this.notSynced.set(path, `Moved from ${elsewhere.path} on the relay. Moves are not followed yet.`);
			return;
		}
		const state = this.states.get(path);
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
			this.notSynced.set(path, "Deleted here. Deletes are not followed yet.");
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
		const state: NoteState = { path, url, syncedHash: await sha256(text), syncedHeads: heads, offlineEdit: false };
		this.states.set(path, state);
		await this.options.store.put(state);
	}
}
