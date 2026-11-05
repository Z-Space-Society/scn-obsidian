import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import { initializeBase64Wasm } from "@automerge/automerge/slim";
import { Repo } from "@automerge/automerge-repo/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { Notice, Plugin, TFile, TFolder, requestUrl, setIcon } from "obsidian";
import {
	PROTOCOL_ACTION,
	SignInError,
	TokenKeeper,
	beginSignIn,
	discover,
	exchangeCode,
	matchCallback,
	normaliseSyncUrl,
	subjectOf,
	type Http,
	type PendingSignIn,
} from "./auth.ts";
import { Connection, type ConnectionState } from "./connection.ts";
import { IndexedDBNoteStore, deleteDatabase } from "./idb.ts";
import { describe } from "./messages.ts";
import { Mounts, folderOf, type MountVault, type Offer } from "./mounts.ts";
import { ObsidianLocations, newNotesSync, putNewNotesIn, shouldApply, type NoteLocations } from "./newnotes.ts";
import { listVaults, type Listing } from "./relay.ts";
import { DEFAULT_SETTINGS, signedInAsSomeoneElse, type Settings } from "./state.ts";
import { ScnSyncSettingTab } from "./ui/settings.ts";
import { ConnectModal, DeleteGuardModal, MoveModal, SetupModal } from "./ui/setup.ts";
import { StatusModal } from "./ui/status.ts";
import { VaultFiles } from "./vaultfiles.ts";
import { WELCOME, shouldWrite, welcomeNote } from "./welcome.ts";

const PENDING_KEY = "scn-sync-pending-sign-in";
const TYPING_PAUSE_MS = 500;
const SECRET_ID = "scn-sync-refresh-token";
// M5. How often the relay is asked which vaults to mount, besides each time
// the connection opens.
const VAULT_LIST_MS = 15 * 60 * 1000;
// How long a notice about a vault stays up.
const NOTICE_MS = 10_000;

// All HTTP goes through requestUrl: plain fetch is blocked by CORS in the iOS
// webview.
const http: Http = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method ?? "GET",
		headers: request.headers,
		contentType: request.headers?.["Content-Type"],
		body: request.body,
		throw: false,
	});
	let json: unknown = null;
	try {
		json = JSON.parse(response.text);
	} catch {
		// Not JSON. The callers read the status.
	}
	return { status: response.status, json };
};

// The states of "Status and errors", as the member reads them.
export type SyncState = "Not set up" | "Signed out" | "Not connected" | "Syncing" | "Up to date" | "Offline" | "Attention";

const ICONS: Record<SyncState, string> = {
	"Not set up": "log-in",
	"Signed out": "log-in",
	"Not connected": "folder-plus",
	Syncing: "refresh-cw",
	"Up to date": "check-circle",
	Offline: "cloud-off",
	Attention: "alert-triangle",
};

// Today as YYYY-MM-DD in the member's own time zone.
function localDate(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// "A and B", "A, B and C".
function listed(names: string[]): string {
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default class ScnSync extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	keeper!: TokenKeeper;
	// Set by whichever settings screen is showing, so a sign-in finishing in
	// the background redraws it.
	onChange: (() => void) | null = null;
	// The setup modal while it is open, so a sign-in finishing in the
	// background can close it.
	setupModal: SetupModal | null = null;
	// Present while syncing: every mounted vault (M1).
	mounts: Mounts | null = null;
	connectionState: ConnectionState | null = null;
	// When the status last reached Up to date, this session.
	lastSynced: number | null = null;
	private repo: Repo | null = null;
	private connection: Connection | null = null;
	private starting: Promise<void> | null = null;
	private wasm: Promise<void> | null = null;
	private refreshing: Promise<void> = Promise.resolve();
	private files!: VaultFiles;
	// Typing in an open note, per path, waiting to be sent.
	private typing = new Map<string, number>();
	private statusEl!: HTMLElement;
	private ribbonEl!: HTMLElement;
	private vaultProblemShown = false;
	locations!: NoteLocations;

	async onload() {
		const saved = (await this.loadData()) as Partial<Settings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		// M8. A vault 1.0 connected is connected still; its notes move into
		// their folder once the relay has said where.
		if (this.settings.vaultUrl) this.settings.connected = true;
		this.files = new VaultFiles(this.app);
		this.locations = new ObsidianLocations(this.app);
		this.keeper = new TokenKeeper({
			http,
			secrets: {
				get: () => this.app.secretStorage.getSecret(SECRET_ID) || null,
				set: (value) => this.app.secretStorage.setSecret(SECRET_ID, value),
			},
			client: () =>
				this.settings.tokenEndpoint
					? { tokenEndpoint: this.settings.tokenEndpoint, issuer: this.settings.issuer }
					: null,
			now: Date.now,
			sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
		});

		// Registered in onload so a callback that starts Obsidian still lands.
		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.finishSignIn(params));

		this.addCommand({ id: "sign-in", name: "Sign in", callback: () => new SetupModal(this.app, this).open() });
		this.addCommand({
			id: "sign-out",
			name: "Sign out",
			checkCallback: (checking) => {
				if (!this.signedIn()) return false;
				if (!checking) this.signOut();
				return true;
			},
		});
		this.addCommand({
			id: "connect",
			name: "Connect to SCN",
			checkCallback: (checking) => {
				if (!this.signedIn() || this.settings.connected) return false;
				if (!checking) void this.connect();
				return true;
			},
		});
		this.addCommand({
			id: "disconnect",
			name: "Disconnect from SCN",
			checkCallback: (checking) => {
				if (!this.settings.connected) return false;
				if (!checking) void this.disconnect();
				return true;
			},
		});
		this.addCommand({
			id: "open-status",
			name: "Open sync status",
			callback: () => new StatusModal(this.app, this).open(),
		});
		this.addCommand({
			id: "reconnect",
			name: "Reconnect now",
			checkCallback: (checking) => {
				if (!this.connection) return false;
				if (!checking) this.connection.resume();
				return true;
			},
		});
		this.addSettingTab(new ScnSyncSettingTab(this.app, this));
		this.ribbonEl = this.addRibbonIcon("refresh-cw", "SCN Sync", () => new StatusModal(this.app, this).open());
		// Not available on iOS, where the ribbon and settings carry the status.
		this.statusEl = this.addStatusBarItem();
		this.showStatus();

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.connection?.resume();
		});
		// onload only registers things. The WASM, the repo, IndexedDB and the
		// socket start once the workspace is up.
		this.app.workspace.onLayoutReady(() => {
			// Registered here, which skips the create event Obsidian fires for
			// every existing file at load.
			const { vault } = this.app;
			this.registerEvent(
				vault.on("create", (file) => {
					if (file instanceof TFile || file instanceof TFolder) this.mounts?.created(file.path, file instanceof TFolder);
					this.showStatus();
				}),
			);
			this.registerEvent(
				vault.on("delete", (file) => {
					this.mounts?.deleted(file.path, file instanceof TFolder);
					this.showStatus();
				}),
			);
			this.registerEvent(
				vault.on("rename", (file, oldPath) => {
					this.mounts?.renamed(oldPath, file.path, file instanceof TFolder);
					this.showStatus();
				}),
			);
			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					if (file instanceof TFile && this.files.synced(file.path)) this.mounts?.fileChanged(file.path);
				}),
			);
			// O5. The buffer of an open note is sent as it is typed, half a
			// second after the last keystroke, without waiting for a save.
			this.registerEvent(
				this.app.workspace.on("editor-change", (_editor, info) => {
					const path = info.file?.path;
					if (!path || !this.files.synced(path)) return;
					window.clearTimeout(this.typing.get(path));
					this.typing.set(
						path,
						window.setTimeout(() => {
							this.typing.delete(path);
							this.mounts?.fileChanged(path);
						}, TYPING_PAUSE_MS),
					);
				}),
			);
			void this.startSync();
		});
		this.registerInterval(window.setInterval(() => void this.refreshVaults(), VAULT_LIST_MS));
	}

	onunload() {
		for (const timer of this.typing.values()) window.clearTimeout(timer);
		void this.stopSync();
	}

	onUserEnable() {
		new SetupModal(this.app, this).open();
	}

	signedIn(): boolean {
		return this.keeper.hasRefreshToken();
	}

	async save() {
		await this.saveData(this.settings);
		this.onChange?.();
	}

	// S1 and S2. Returns the address at Corliss to open. The caller opens it
	// from a tap of its own: iOS ignores window.open once a tap has waited on
	// the network.
	async prepareSignIn(input: string): Promise<string> {
		const syncUrl = normaliseSyncUrl(input);
		const endpoints = await discover(http, syncUrl, this.settings.issuerOverride.trim() || undefined);
		const { pending, url } = await beginSignIn(endpoints, syncUrl, Date.now());
		this.app.saveLocalStorage(PENDING_KEY, pending);
		return url;
	}

	// S3 and S4. The browser has handed back to Obsidian.
	async finishSignIn(params: Record<string, string | undefined>) {
		const pending = this.app.loadLocalStorage(PENDING_KEY) as PendingSignIn | null;
		const callback = matchCallback(pending, params, Date.now());
		if (callback.kind === "foreign") {
			new Notice("SCN Sync: this sign-in was not started in this vault.");
			return;
		}
		this.app.saveLocalStorage(PENDING_KEY, null);
		if (callback.kind === "refused") {
			new Notice(`SCN Sync: ${callback.message}`, 0);
			return;
		}
		try {
			const tokens = await exchangeCode(http, callback.pending, callback.code, Date.now());
			const did = subjectOf(tokens.accessToken);
			if (signedInAsSomeoneElse(this.settings, did)) {
				throw new SignInError(
					"This vault is connected to SCN as another member. Disconnect it first, then sign in.",
				);
			}
			this.keeper.adopt(tokens);
			Object.assign(this.settings, {
				syncUrl: callback.pending.syncUrl,
				issuer: callback.pending.issuer,
				tokenEndpoint: callback.pending.tokenEndpoint,
				did,
			});
			await this.save();
			new Notice("SCN Sync: signed in.");
			this.setupModal?.close();
			if (!this.settings.connected) void this.connect();
			else void this.startSync();
		} catch (e) {
			new Notice(`SCN Sync: ${describe(e)}`, 0);
		}
	}

	async vaults(): Promise<Listing> {
		return listVaults(http, this.settings.syncUrl, await this.keeper.accessToken());
	}

	// M1. This Obsidian vault syncs every SCN vault the member can open, each
	// in the folder its relay path names. Nothing outside those folders syncs.
	async connect() {
		this.settings.connected = true;
		await this.save();
		await this.startSync();
	}

	// Keeps every file. The repo and every vault's note store go, so a later
	// connect starts from the connect procedure.
	async disconnect() {
		await this.stopSync();
		if (this.settings.storeId) {
			const stores = [
				this.storeName(),
				`${this.storeName()}-notes`,
				...Object.values(this.settings.mounts).map((record) => record.store),
			];
			for (const name of stores) await deleteDatabase(name);
		}
		Object.assign(this.settings, { connected: false, mounts: {}, vaultUrl: "", vaultName: "", storeId: "" });
		await this.save();
	}

	// S6. Local files and documents are kept.
	signOut() {
		void this.stopSync();
		this.keeper.signOut();
		this.onChange?.();
	}

	private storeName(): string {
		return `scn-sync-${this.settings.storeId}`;
	}

	startSync(): Promise<void> {
		this.starting ??= this.runSync().finally(() => (this.starting = null));
		return this.starting;
	}

	private async runSync() {
		if (this.mounts || !this.settings.connected || !this.signedIn()) {
			this.showStatus();
			return;
		}
		this.wasm ??= initializeBase64Wasm(automergeWasmBase64);
		await this.wasm;
		if (!this.settings.storeId) {
			this.settings.storeId = crypto.randomUUID();
			await this.save();
		}
		// IndexedDB is a cache of the relay. Asked, and the answer ignored:
		// iOS refused it in testing.
		void navigator.storage?.persist?.().catch(() => false);

		// One repo and one socket for every vault: document IDs are unique
		// across them, and the relay checks each document on its own.
		const repo = new Repo({ storage: new IndexedDBStorageAdapter(this.storeName()), network: [] });
		const connection = new Connection({
			repo,
			syncUrl: this.settings.syncUrl,
			keeper: this.keeper,
			onState: (state) => {
				const was = this.connectionState;
				this.connectionState = state;
				if ((state === "online") !== (was === "online")) {
					this.mounts?.connectionChanged(state === "online");
					// M5. Each time the connection opens, the token behind it
					// says which workspaces this member is in now.
					if (state === "online") void this.refreshVaults();
				}
				if (state === "signed out" && was !== "signed out") {
					new Notice("SCN Sync: signed out. Sign in again to keep syncing.", 0);
				}
				this.showStatus();
			},
		});
		const notice = (text: string) => new Notice(`SCN Sync: ${text}`, NOTICE_MS);
		const mounts = new Mounts(
			{
				repo,
				files: this.files,
				openStore: (name) => new IndexedDBNoteStore(name),
				deleteStore: (name) => deleteDatabase(name),
				newStoreName: (rootDocId) => `${this.storeName()}-notes-${rootDocId}`,
				saveRecords: async (records) => {
					this.settings.mounts = records;
					await this.save();
				},
				confirm: (plan, path) => new ConnectModal(this.app, plan, path).ask(),
				confirmDeletes: (paths, path) => new DeleteGuardModal(this.app, paths, path).ask(),
				confirmMove: (move) => new MoveModal(this.app, move).ask(),
				offerMove: (offer, into) => this.offerMove(offer, into),
				listed: () => this.listedFolders(),
				localOnly: (path) => path === this.settings.welcome,
				notify: notice,
				online: () => this.connection?.state === "online",
				onStatus: () => this.showStatus(),
				today: localDate,
			},
			this.settings.mounts,
		);
		Object.assign(this, { repo, connection, mounts });
		connection.start();
		await mounts.start();
		void this.refreshVaults();
	}

	// M5. Mount what the relay lists now. Offline, or refused, what is mounted
	// stays mounted and syncs when the connection comes back. One at a time:
	// start and the connection opening both ask, and two migrations (M8) at
	// once would move the first one's folder into the second's.
	refreshVaults(): Promise<void> {
		const next = this.refreshing.then(() => this.refreshOnce());
		this.refreshing = next.catch((e) => console.error("SCN Sync: refreshing vaults failed", e));
		return this.refreshing;
	}

	private async refreshOnce() {
		const { mounts } = this;
		if (!mounts || !this.signedIn()) return;
		let listing: Listing;
		try {
			listing = await this.vaults();
		} catch {
			return;
		}
		if (this.mounts !== mounts) return;
		const vaults: MountVault[] = listing.vaults.map(({ rootDocId, url, path, workspace }) => ({
			rootDocId,
			url,
			path,
			private: workspace === null,
		}));
		// M8, once, and only against a relay that names paths.
		if (this.settings.vaultUrl && vaults.every((vault) => vault.path !== "")) {
			const name = this.settings.vaultName;
			const moved = await mounts.migrate(vaults, this.settings.vaultUrl, `${this.storeName()}-notes`, (folder) =>
				this.moveRoot(folder),
			);
			if (moved) {
				new Notice(`SCN Sync: ${name} now syncs in its own folder, beside any workspaces you are in.`, 0);
			} else {
				await deleteDatabase(`${this.storeName()}-notes`);
				new Notice(`SCN Sync: ${name} is no longer on SCN. Its notes stay here and do not sync.`, 0);
			}
			this.settings.vaultUrl = "";
			this.settings.vaultName = "";
			await this.save();
		}
		await mounts.update(vaults);
		await this.makeFolders(listing.folders);
		await this.applyNewNotesOnce();
		await this.writeWelcomeOnce();
	}

	// M12. Once per device, after the M8 move so it stays at the root: SCN's
	// Welcome.md in place of Obsidian's. Waits for a listing that names the
	// folders, which the note names. Recorded before it is written, so its own
	// create event finds it kept here on purpose.
	private async writeWelcomeOnce() {
		const into = this.privateFolder();
		const folders = this.listedFolders();
		if (this.settings.welcome !== null || !this.mounts || !into || folders.length === 0) return;
		const existing = await this.files.read(WELCOME);
		const onlyNote = this.mounts.outside().every((path) => path === WELCOME);
		const write = shouldWrite(existing, onlyNote);
		this.settings.welcome = write ? WELCOME : "";
		await this.save();
		if (write) await this.files.write(WELCOME, welcomeNote(into, folders), existing);
	}

	// M5. Each folder the relay groups vaults under, made even with nothing in
	// it, so a member in no workspace still sees where workspaces will appear.
	// Kept, so what the relay calls them is known offline.
	private async makeFolders(folders: string[]) {
		if (folders.length === 0) return;
		// Made safe as a vault's folder is, so `Workspaces` here is the same
		// folder `Workspaces/<name>` is made in.
		for (const folder of folders) {
			const safe = folderOf(folder);
			if (safe) await this.files.makeFolder(safe);
		}
		if (folders.join("\n") !== this.settings.folders.join("\n")) {
			this.settings.folders = folders;
			await this.save();
		}
	}

	// M10. Notes that landed outside every vault, offered a move into the
	// private vault. Nothing moves unless the member taps Move.
	// The offer's paths are read at the click, not now: they follow renames,
	// such as Obsidian's `Untitled.md` taking the name the member types.
	private offerMove(offer: Offer, into: string | null) {
		const folders = this.settings.folders;
		const which = folders.length > 0 ? `${listed(folders)} folders` : "your SCN vaults' folders";
		const fragment = createFragment((f) => {
			f.createDiv({ text: `SCN Sync: Only ${which} are synced.` });
			if (!into) return;
			f.createEl("button", { text: `Move to ${into}`, cls: "mod-cta" }).addEventListener("click", () => {
				void this.moveIntoPrivate([...offer.paths]);
			});
		});
		new Notice(fragment, 0);
	}

	// M5. The relay's folders, made safe as `makeFolders` makes them.
	private listedFolders(): string[] {
		return this.settings.folders.flatMap((folder) => folderOf(folder) ?? []);
	}

	// M10. Into the private vault's folder, as new notes there.
	async moveIntoPrivate(paths: string[]) {
		const { mounts } = this;
		if (!mounts) return;
		const missed: string[] = [];
		for (const path of paths) if ((await mounts.moveIntoPrivate(path)) === null) missed.push(path);
		if (missed.length > 0) new Notice(`SCN Sync: could not move ${missed.join(", ")}. Move it into a vault's folder by hand.`, NOTICE_MS);
		this.showStatus();
		this.onChange?.();
	}

	// M11. The private vault's folder, from the vault listed with no workspace.
	privateFolder(): string | null {
		return Object.values(this.settings.mounts).find((record) => record.private)?.folder ?? null;
	}

	vaultFolders(): string[] {
		return Object.values(this.settings.mounts).map((record) => record.folder);
	}

	newNotesSync(): boolean {
		return newNotesSync(this.locations, this.vaultFolders());
	}

	// M11. Once per device, with no question: new notes go in the private
	// vault's folder, so they sync. Recorded either way, so a member who later
	// points new notes elsewhere is left there.
	private async applyNewNotesOnce() {
		if (!shouldApply(this.settings.newNotesAnswer, this.privateFolder())) return;
		if (!this.newNotesSync()) {
			await this.putNewNotesInPrivate();
			return;
		}
		this.settings.newNotesAnswer = "yes";
		await this.save();
	}

	// M11. Also the settings tab's button.
	async putNewNotesInPrivate() {
		const into = this.privateFolder();
		if (!into) return;
		const dailyByHand = await putNewNotesIn(into, this.locations, this.vaultFolders());
		this.settings.newNotesAnswer = "yes";
		await this.save();
		new Notice(
			dailyByHand
				? `SCN Sync: new notes now go in ${into}, so they sync. To sync daily notes too, set the folder under Settings, Daily notes, New file location to ${into}.`
				: `SCN Sync: new notes now go in ${into}, so they sync. Change it under Settings, Files and links, Default location for new notes.`,
			dailyByHand ? 0 : NOTICE_MS,
		);
	}

	// M8. Everything at the root goes into the folder, by way of a folder of
	// its own: the vault being moved may hold a folder with the same name as
	// the one it moves into. `vault.rename`, never link rewriting: two devices
	// rewriting the same links would sync the same edit twice.
	private async moveRoot(folder: string) {
		const mounts = this.mounts!;
		const staging = `SCN Sync moving ${Date.now()}`;
		for (const child of [...this.app.vault.getRoot().children]) {
			const to = `${staging}/${child.name}`;
			mounts.expectMove(child.path, to);
			await this.files.rename(child.path, to);
		}
		if (!this.files.hasFolder(staging)) return;
		mounts.expectMove(staging, folder);
		await this.files.rename(staging, folder);
	}

	async stopSync() {
		await this.starting?.catch(() => {});
		const { mounts, connection, repo } = this;
		Object.assign(this, { mounts: null, connection: null, repo: null, connectionState: null });
		await mounts?.stop();
		connection?.stop();
		await repo?.shutdown().catch(() => {});
		this.showStatus();
	}

	state(): SyncState {
		const { settings, mounts, connectionState } = this;
		if (!settings.connected) return this.signedIn() ? "Not connected" : "Not set up";
		if (!this.signedIn() || connectionState === "signed out") return "Signed out";
		if (mounts && (mounts.guarding() > 0 || mounts.notSynced().length > 0 || mounts.outside().length > 0)) return "Attention";
		if (connectionState === "offline") return "Offline";
		if (!mounts || mounts.working || mounts.unsent().length > 0 || connectionState !== "online") return "Syncing";
		return "Up to date";
	}

	statusText(): string {
		const state = this.state();
		const { mounts } = this;
		if (state === "Attention" && mounts) {
			const guarding = mounts.guarding();
			if (guarding > 0) return `${state}: ${guarding} notes missing here`;
			return `${state}: ${mounts.notSynced().length + mounts.outside().length} not syncing`;
		}
		const unsent = mounts?.unsent().length ?? 0;
		if (state === "Syncing" && unsent > 0) return `${state}, ${unsent} not uploaded`;
		return state;
	}

	// The status bar and the ribbon. The settings tab reads the status when
	// drawn, and redrawing it on every change would take the cursor out of
	// its fields.
	showStatus() {
		const state = this.state();
		if (state === "Up to date") this.lastSynced = Date.now();
		const text = `SCN Sync: ${this.statusText()}`;
		this.statusEl?.setText(text);
		if (this.ribbonEl) {
			setIcon(this.ribbonEl, ICONS[state]);
			this.ribbonEl.setAttribute("aria-label", text);
		}
		// N5. Only this needs the member to act; the guard asks in its modal.
		const problem = this.mounts?.vaultProblem() ?? false;
		if (problem && !this.vaultProblemShown) {
			new Notice("SCN Sync: several notes are not available from SCN. Check the vault on Corliss's Notes page.", 0);
		}
		this.vaultProblemShown = problem;
	}

	// Corliss's Notes page, the only place a private vault is made.
	notesPage(): string | null {
		return this.settings.issuer ? `${this.settings.issuer}/notes/` : null;
	}
}
