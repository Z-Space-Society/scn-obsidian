// M1 to M7. One Obsidian vault holds every SCN vault the member can open.
//
// Each SCN vault is mounted at the folder its relay `path` names, such as
// `Private/Notes` or `Workspaces/SCN Development`, and syncs through a `Sync`
// of its own that sees only that folder (`ScopedFiles`). Everything here is
// the layer around those engines: which vaults are mounted and where, which
// engine a file event belongs to, and the moves no single engine can make.
//
// The words "Private" and "Workspaces" appear nowhere in this file. They are
// the first segment of the relay's `path`, and the relay is the one place they
// are spelled.

import type { Repo } from "@automerge/automerge-repo/slim";
import type { Files, NoteStore } from "./notes.ts";
import { nameKey } from "./schema.ts";
import { ScopedFiles } from "./scoped.ts";
import { EVENT_BATCH_MS, Sync, type Plan } from "./sync/sync.ts";
import { within } from "./tree.ts";

// What is kept per mounted vault in `data.json`, so a vault mounts again at
// start without asking the relay, offline included.
export interface MountRecord {
	url: string;
	// The relay's `path` when last listed.
	path: string;
	// Where it is mounted. Usually `path` made safe; see `assignFolders`.
	folder: string;
	// The IndexedDB name of its note store.
	store: string;
}

// The part of a listed vault a mount needs.
export interface MountVault {
	rootDocId: string;
	url: string;
	path: string;
}

// A move across the boundary between two vaults, as the member is asked it.
export interface CrossMove {
	from: string;
	to: string;
	fromVault: string;
	toVault: string;
	notes: number;
}

export type ClosableStore = NoteStore & { close?: () => Promise<void> };

export interface MountsOptions {
	repo: Repo;
	// The whole Obsidian vault.
	files: Files;
	openStore: (name: string) => ClosableStore;
	deleteStore: (name: string) => Promise<void>;
	newStoreName: (rootDocId: string) => string;
	saveRecords: (records: Record<string, MountRecord>) => Promise<void>;
	// V3, asked only when connecting would copy or upload anything (M6).
	confirm: (plan: Plan, vaultPath: string) => Promise<boolean>;
	confirmDeletes: (paths: string[], vaultPath: string) => Promise<boolean>;
	// M4. True makes the move; false puts it back.
	confirmMove: (move: CrossMove) => Promise<boolean>;
	notify: (text: string) => void;
	online: () => boolean;
	onStatus: () => void;
	today: () => string;
}

interface Mount {
	id: string;
	record: MountRecord;
	store: ClosableStore;
	sync: Sync;
}

// A rename this layer made itself, whose events are not the member's.
interface Expected {
	from: string;
	to: string;
	until: number;
}

type Rename = { from: string; to: string; folder: boolean };

// How long the events of a rename made here keep arriving.
const EXPECT_MS = 2_000;

// M2. One segment of a mount folder: what Obsidian and the file systems it
// runs on can hold. The relay allows any name; a file name cannot.
export function safeSegment(segment: string): string {
	const safe = segment
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/^[.\s]+/, "")
		.trim();
	return safe || "Untitled";
}

// M2. The folder a relay `path` is mounted at: its group, then its name, each
// made safe. Null for a path with no group, which this version does not mount.
export function folderOf(path: string): string | null {
	const slash = path.indexOf("/");
	if (slash <= 0 || slash === path.length - 1) return null;
	return `${safeSegment(path.slice(0, slash))}/${safeSegment(path.slice(slash + 1))}`;
}

// M2. A folder for every vault. A vault keeps the folder it already has while
// its path still leads there, so names stay put across restarts; two vaults
// whose folders would collide get " (2)", " (3)" in the order listed.
export function assignFolders(vaults: MountVault[], records: Record<string, MountRecord>): Map<string, string> {
	const assigned = new Map<string, string>();
	const taken = new Set<string>();
	const wanted = new Map<string, string>();
	for (const vault of vaults) {
		const folder = folderOf(vault.path);
		if (folder) wanted.set(vault.rootDocId, folder);
	}
	for (const [id, base] of wanted) {
		const kept = records[id]?.folder;
		if (!kept || taken.has(nameKey(kept))) continue;
		if (kept === base || kept.startsWith(`${base} (`)) {
			assigned.set(id, kept);
			taken.add(nameKey(kept));
		}
	}
	for (const [id, base] of wanted) {
		if (assigned.has(id)) continue;
		let folder = base;
		for (let n = 2; taken.has(nameKey(folder)); n++) folder = `${base} (${n})`;
		assigned.set(id, folder);
		taken.add(nameKey(folder));
	}
	return assigned;
}

// M8. A vault connected by SCN Sync 1.0, whose notes sit at the Obsidian
// vault's root. Its record, mounted at the folder its path now names and
// keeping its old note store, whose paths were already relative to the root.
// Null when the relay no longer lists it.
export function legacyRecord(
	vaults: MountVault[],
	records: Record<string, MountRecord>,
	legacyUrl: string,
	legacyStore: string,
): { id: string; record: MountRecord } | null {
	const vault = vaults.find((v) => v.url === legacyUrl);
	if (!vault) return null;
	const folder = assignFolders(vaults, records).get(vault.rootDocId);
	if (!folder) return null;
	return { id: vault.rootDocId, record: { url: vault.url, path: vault.path, folder, store: legacyStore } };
}

// M6. Connecting asks only when it would copy or upload. Downloading into an
// empty folder, or finding every file already matching, goes ahead, so a new
// workspace appears without a question.
export function needsAsking(plan: Plan): boolean {
	return plan.copy.length > 0 || plan.localOnly.length > 0;
}

function moved(path: string, from: string, to: string): string {
	return to + path.slice(from.length);
}

function depth(path: string): number {
	return path.split("/").length;
}

export class Mounts {
	readonly mounts = new Map<string, Mount>();
	records: Record<string, MountRecord> = {};
	// Vaults the member declined to connect, left alone until the next start.
	private declined = new Set<string>();
	private expected: Expected[] = [];
	private renames: Rename[] = [];
	private renameTimer: ReturnType<typeof setTimeout> | null = null;
	private updates: Promise<void> = Promise.resolve();
	private stopped = false;
	private warnedOld = false;
	private options: MountsOptions;

	constructor(options: MountsOptions, records: Record<string, MountRecord>) {
		this.options = options;
		this.records = { ...records };
	}

	// Mount what was mounted last time, before the relay is asked: a vault
	// syncs offline and from its own store.
	start(): Promise<void> {
		const vaults = Object.entries(this.records).map(([rootDocId, r]) => ({ rootDocId, url: r.url, path: r.path }));
		return this.update(vaults);
	}

	// M5. The relay's list of vaults, applied. One update at a time.
	update(vaults: MountVault[]): Promise<void> {
		const next = this.updates.then(() => this.apply(vaults)).catch((e) => console.error("SCN Sync: updating vaults failed", e));
		this.updates = next;
		return next;
	}

	private async apply(vaults: MountVault[]) {
		if (this.stopped) return;
		const { files } = this.options;
		// A relay older than v0.4.2 names no paths. Read as a list of nothing,
		// it would unmount every vault, so it is not read at all.
		if (vaults.some((vault) => vault.path === "")) {
			if (!this.warnedOld) this.options.notify("The SCN relay needs updating before this version of SCN Sync can sync.");
			this.warnedOld = true;
			return;
		}
		const usable = vaults.filter((vault) => folderOf(vault.path) !== null);
		const folders = assignFolders(usable, this.records);

		// Gone from the list: the member left the workspace, or the vault went.
		for (const [id, record] of Object.entries(this.records)) {
			if (folders.has(id)) continue;
			await this.unmount(id);
			await this.options.deleteStore(record.store);
			delete this.records[id];
			this.options.notify(`${record.path} no longer syncs. Its files stay in ${record.folder}.`);
		}

		for (const vault of usable) {
			const folder = folders.get(vault.rootDocId)!;
			const record = this.records[vault.rootDocId];
			if (record && record.folder !== folder) {
				// Renamed in Corliss. The folder follows; the store's paths are
				// relative, so it needs nothing.
				await this.unmount(vault.rootDocId);
				if (files.hasFolder(record.folder) && !files.hasFolder(folder)) {
					this.expect(record.folder, folder);
					await files.rename(record.folder, folder);
				}
			}
			this.records[vault.rootDocId] = {
				url: vault.url,
				path: vault.path,
				folder,
				store: record?.store ?? this.options.newStoreName(vault.rootDocId),
			};
		}
		await this.options.saveRecords({ ...this.records });

		for (const vault of usable) {
			if (!this.mounts.has(vault.rootDocId) && !this.declined.has(vault.rootDocId)) this.mount(vault.rootDocId);
		}
		this.options.onStatus();
	}

	private mount(id: string) {
		const record = this.records[id];
		const store = this.options.openStore(record.store);
		const sync: Sync = new Sync({
			repo: this.options.repo,
			rootUrl: record.url,
			files: new ScopedFiles(this.options.files, record.folder),
			store,
			confirm: async (plan) => !needsAsking(plan) || this.options.confirm(plan, record.path),
			confirmDeletes: (paths) => this.options.confirmDeletes(paths, record.path),
			online: this.options.online,
			onStatus: () => {
				if (sync.declined && this.mounts.get(id)?.sync === sync) {
					this.declined.add(id);
					void this.unmount(id);
				}
				this.options.onStatus();
			},
			today: this.options.today,
		});
		this.mounts.set(id, { id, record, store, sync });
		void sync.start().catch((e) => console.error(`SCN Sync: starting ${record.path} failed`, e));
	}

	private async unmount(id: string) {
		const mount = this.mounts.get(id);
		if (!mount) return;
		this.mounts.delete(id);
		mount.sync.stop();
		await mount.store.close?.();
	}

	// M7. The vault's folder was deleted here. Nothing is deleted on SCN:
	// the store is cleared, and the engine connects again, downloading it.
	private async downloadAgain(id: string) {
		const record = this.records[id];
		await this.unmount(id);
		await this.options.deleteStore(record.store);
		this.options.notify(`${record.folder} is downloaded again. A vault is removed in Corliss, not by deleting its folder.`);
		if (!this.stopped) this.mount(id);
	}

	async stop() {
		this.stopped = true;
		if (this.renameTimer !== null) clearTimeout(this.renameTimer);
		for (const id of [...this.mounts.keys()]) await this.unmount(id);
	}

	// The mount a path is inside, not counting the mount's own folder.
	owner(path: string): Mount | null {
		for (const mount of this.mounts.values()) {
			if (path !== mount.record.folder && within(path, mount.record.folder)) return mount;
		}
		return null;
	}

	private relative(mount: Mount, path: string): string {
		return path.slice(mount.record.folder.length + 1);
	}

	// A group folder or a vault's folder, which only Corliss names (M7).
	private guarded(path: string): Mount[] {
		return [...this.mounts.values()].filter((mount) => within(mount.record.folder, path));
	}

	// --- File events ------------------------------------------------------

	created(path: string) {
		const mount = this.owner(path);
		mount?.sync.created(this.relative(mount, path));
	}

	fileChanged(path: string) {
		const mount = this.owner(path);
		mount?.sync.fileChanged(this.relative(mount, path));
	}

	deleted(path: string, folder: boolean) {
		const guarded = this.guarded(path);
		if (guarded.length > 0) {
			for (const mount of guarded) void this.downloadAgain(mount.id);
			return;
		}
		const mount = this.owner(path);
		if (!mount) return;
		// The events of a vault folder's own deletion can arrive before the
		// folder's: by then the folder is gone, and none of them is passed on.
		if (!this.options.files.hasFolder(mount.record.folder)) {
			void this.downloadAgain(mount.id);
			return;
		}
		mount.sync.deleted(this.relative(mount, path), folder);
	}

	renamed(from: string, to: string, folder: boolean) {
		if (this.isExpected(from, to)) return;
		const source = this.owner(from);
		const destination = this.owner(to);
		if (source && source === destination) {
			source.sync.renamed(this.relative(source, from), this.relative(source, to), folder);
			return;
		}
		// Everything else waits for the rest of its batch: a folder's move
		// arrives as one event or many, and is answered once.
		this.renames.push({ from, to, folder });
		this.renameTimer ??= setTimeout(() => {
			this.renameTimer = null;
			const batch = this.renames;
			this.renames = [];
			void this.applyRenames(batch);
		}, EVENT_BATCH_MS);
	}

	// M8. A move made outside this layer whose events are not the member's,
	// such as the migration's.
	expectMove(from: string, to: string) {
		this.expect(from, to);
	}

	// M8. The 1.0 vault becomes a mount: `moveRoot` moves the notes at the
	// Obsidian vault's root into the folder given, and its store is kept.
	// False when the relay no longer lists it, and nothing is moved.
	async migrate(vaults: MountVault[], legacyUrl: string, legacyStore: string, moveRoot: (folder: string) => Promise<void>): Promise<boolean> {
		const legacy = legacyRecord(vaults, this.records, legacyUrl, legacyStore);
		if (!legacy) return false;
		await moveRoot(legacy.record.folder);
		this.records[legacy.id] = legacy.record;
		await this.options.saveRecords({ ...this.records });
		return true;
	}

	private expect(from: string, to: string) {
		this.expected.push({ from, to, until: Date.now() + EXPECT_MS });
	}

	private isExpected(from: string, to: string): boolean {
		const now = Date.now();
		this.expected = this.expected.filter((e) => e.until > now);
		return this.expected.some((e) => within(from, e.from) && to === moved(from, e.from, e.to));
	}

	private async putBack(from: string, to: string) {
		this.expect(to, from);
		await this.options.files.rename(to, from);
	}

	private filesUnder(path: string, folder: boolean): string[] {
		const { files } = this.options;
		if (!folder) return files.synced(path) ? [path] : [];
		return files.list().filter((p) => within(p, path));
	}

	private async applyRenames(batch: Rename[]) {
		if (this.stopped) return;
		// Shallowest first. A move a folder's event answers, its children's
		// events do not answer again.
		batch.sort((a, b) => depth(a.from) - depth(b.from));
		const answered: Rename[] = [];
		for (const rename of batch) {
			const { from, to, folder } = rename;
			if (answered.some((a) => within(from, a.from) && to === moved(from, a.from, a.to))) continue;
			if (this.isExpected(from, to)) continue;
			answered.push(rename);

			// M7. A group folder or a vault's folder: put back.
			if (this.guarded(from).length > 0) {
				await this.putBack(from, to);
				this.options.notify("SCN vault folders are named in Corliss. Moved back.");
				continue;
			}

			const source = this.owner(from);
			const destination = this.owner(to);
			if (source && destination) {
				await this.moveAcross(source, destination, rename);
			} else if (source) {
				// M4. Out of every vault: it would stop syncing without a word.
				await this.putBack(from, to);
				this.options.notify(`${to} is outside your SCN vaults. Moved back.`);
			} else if (destination) {
				// Brought into a vault from outside: new notes there.
				for (const path of this.filesUnder(to, folder)) destination.sync.created(this.relative(destination, path));
			}
		}
		this.options.onStatus();
	}

	// M4. A note cannot move between vaults: a workspace's vault admits only
	// documents created for it. Yes makes it new notes there and removes it
	// from where it was; no puts it back.
	private async moveAcross(source: Mount, destination: Mount, { from, to, folder }: Rename) {
		const paths = this.filesUnder(to, folder);
		const yes = await this.options.confirmMove({
			from,
			to,
			fromVault: source.record.path,
			toVault: destination.record.path,
			notes: paths.length,
		});
		if (!yes) {
			await this.putBack(from, to);
			return;
		}
		source.sync.deleted(this.relative(source, from), folder);
		for (const path of paths) destination.sync.created(this.relative(destination, path));
	}

	// --- Status -------------------------------------------------------------

	connectionChanged(online: boolean) {
		for (const { sync } of this.mounts.values()) sync.connectionChanged(online);
	}

	get working(): boolean {
		return [...this.mounts.values()].some(({ sync }) => sync.working);
	}

	// Each over every mount, with full paths.
	unsent(): string[] {
		return [...this.mounts.values()].flatMap(({ record, sync }) => sync.unsent().map((p) => `${record.folder}/${p}`));
	}

	notSynced(): Array<[string, string]> {
		return [...this.mounts.values()].flatMap(({ record, sync }) =>
			[...sync.notSynced].map(([p, reason]): [string, string] => [`${record.folder}/${p}`, reason]),
		);
	}

	guarding(): number {
		return [...this.mounts.values()].reduce((n, { sync }) => n + sync.guard.length, 0);
	}

	vaultProblem(): boolean {
		return [...this.mounts.values()].some(({ sync }) => sync.vaultProblem());
	}

	skipped(): string[] {
		return [...this.mounts.values()].flatMap(({ record, sync }) => sync.skipped.map((line) => `${record.path}: ${line}`));
	}

	// For tests and a status that settles.
	async idle() {
		await this.updates;
		while (this.renameTimer !== null) await new Promise((resolve) => setTimeout(resolve, EVENT_BATCH_MS));
		await Promise.all([...this.mounts.values()].map(({ sync }) => sync.idle()));
	}
}
