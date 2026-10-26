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
import { listVaults, type Vault } from "./relay.ts";
import { DEFAULT_SETTINGS, signedInAsSomeoneElse, type Settings } from "./state.ts";
import { ScnSyncSettingTab } from "./ui/settings.ts";
import { Sync } from "./sync/sync.ts";
import { ConnectModal, DeleteGuardModal, SetupModal, VaultPickModal } from "./ui/setup.ts";
import { StatusModal } from "./ui/status.ts";
import { VaultFiles } from "./vaultfiles.ts";

const PENDING_KEY = "scn-sync-pending-sign-in";
const TYPING_PAUSE_MS = 500;
const SECRET_ID = "scn-sync-refresh-token";

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
export type SyncState = "Not set up" | "Signed out" | "No vault" | "Syncing" | "Up to date" | "Offline" | "Attention";

const ICONS: Record<SyncState, string> = {
	"Not set up": "log-in",
	"Signed out": "log-in",
	"No vault": "folder-plus",
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

export default class ScnSync extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	keeper!: TokenKeeper;
	// Set by whichever settings screen is showing, so a sign-in finishing in
	// the background redraws it.
	onChange: (() => void) | null = null;
	// The setup modal while it is open, so a sign-in finishing in the
	// background can close it.
	setupModal: SetupModal | null = null;
	// Present while syncing.
	sync: Sync | null = null;
	connectionState: ConnectionState | null = null;
	// When the status last reached Up to date, this session.
	lastSynced: number | null = null;
	private repo: Repo | null = null;
	private connection: Connection | null = null;
	private noteStore: IndexedDBNoteStore | null = null;
	private starting: Promise<void> | null = null;
	private wasm: Promise<void> | null = null;
	private files!: VaultFiles;
	// Typing in an open note, per path, waiting to be sent.
	private typing = new Map<string, number>();
	private statusEl!: HTMLElement;
	private ribbonEl!: HTMLElement;
	private vaultProblemShown = false;

	async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
		this.files = new VaultFiles(this.app);
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
			id: "choose-vault",
			name: "Choose vault",
			checkCallback: (checking) => {
				if (!this.signedIn() || this.settings.vaultUrl) return false;
				if (!checking) new VaultPickModal(this.app, this).open();
				return true;
			},
		});
		this.addCommand({
			id: "disconnect",
			name: "Disconnect this vault",
			checkCallback: (checking) => {
				if (!this.settings.vaultUrl) return false;
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
					if (file instanceof TFile) this.sync?.created(file.path);
					this.showStatus();
				}),
			);
			this.registerEvent(
				vault.on("delete", (file) => {
					this.sync?.deleted(file.path, file instanceof TFolder);
					this.showStatus();
				}),
			);
			this.registerEvent(
				vault.on("rename", (file, oldPath) => {
					this.sync?.renamed(oldPath, file.path, file instanceof TFolder);
					this.showStatus();
				}),
			);
			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					if (file instanceof TFile && this.files.synced(file.path)) this.sync?.fileChanged(file.path);
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
							this.sync?.fileChanged(path);
						}, TYPING_PAUSE_MS),
					);
				}),
			);
			void this.startSync();
		});
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
					`This vault is connected to ${this.settings.vaultName} as another member. Disconnect it first, then sign in.`,
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
			if (!this.settings.vaultUrl) new VaultPickModal(this.app, this).open();
			else void this.startSync();
		} catch (e) {
			new Notice(`SCN Sync: ${describe(e)}`, 0);
		}
	}

	async vaults(): Promise<Vault[]> {
		return listVaults(http, this.settings.syncUrl, await this.keeper.accessToken());
	}

	// V2. One Obsidian vault connects to one relay vault.
	async connect(vault: Vault) {
		this.settings.vaultUrl = vault.url;
		this.settings.vaultName = vault.name;
		await this.save();
		await this.startSync();
	}

	// Keeps every file. The repo and the per-note state go, so a later
	// connect starts from the connect procedure. Choosing another vault is a
	// disconnect, then a connect.
	async disconnect() {
		await this.stopSync();
		if (this.settings.storeId) {
			await deleteDatabase(this.storeName());
			await deleteDatabase(`${this.storeName()}-notes`);
		}
		this.settings.vaultUrl = "";
		this.settings.vaultName = "";
		this.settings.storeId = "";
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
		if (this.sync || !this.settings.vaultUrl || !this.signedIn()) {
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

		const repo = new Repo({ storage: new IndexedDBStorageAdapter(this.storeName()), network: [] });
		const connection = new Connection({
			repo,
			syncUrl: this.settings.syncUrl,
			keeper: this.keeper,
			onState: (state) => {
				const was = this.connectionState;
				this.connectionState = state;
				if ((state === "online") !== (was === "online")) this.sync?.connectionChanged(state === "online");
				if (state === "signed out" && was !== "signed out") {
					new Notice("SCN Sync: signed out. Sign in again to keep syncing.", 0);
				}
				this.showStatus();
			},
		});
		const noteStore = new IndexedDBNoteStore(`${this.storeName()}-notes`);
		let declined = false;
		const sync = new Sync({
			repo,
			rootUrl: this.settings.vaultUrl,
			files: this.files,
			store: noteStore,
			confirm: (plan) => new ConnectModal(this.app, plan, this.settings.vaultName).ask(),
			confirmDeletes: (paths) => new DeleteGuardModal(this.app, paths, this.settings.vaultName).ask(),
			online: () => this.connection?.state === "online",
			onStatus: () => {
				if (sync.declined && !declined) {
					declined = true;
					void this.disconnect();
				}
				this.showStatus();
			},
			today: localDate,
		});
		Object.assign(this, { repo, connection, noteStore, sync });
		connection.start();
		await sync.start();
	}

	async stopSync() {
		await this.starting?.catch(() => {});
		const { sync, connection, repo, noteStore } = this;
		Object.assign(this, { sync: null, connection: null, repo: null, noteStore: null, connectionState: null });
		sync?.stop();
		connection?.stop();
		await repo?.shutdown().catch(() => {});
		await noteStore?.close();
		this.showStatus();
	}

	state(): SyncState {
		const { settings, sync, connectionState } = this;
		if (!settings.vaultUrl) return this.signedIn() ? "No vault" : "Not set up";
		if (!this.signedIn() || connectionState === "signed out") return "Signed out";
		if (sync && (sync.guard.length > 0 || sync.notSynced.size > 0)) return "Attention";
		if (connectionState === "offline") return "Offline";
		if (!sync || sync.working || sync.unsent().length > 0 || connectionState !== "online") return "Syncing";
		return "Up to date";
	}

	statusText(): string {
		const state = this.state();
		const { sync } = this;
		if (state === "Attention" && sync) {
			if (sync.guard.length > 0) return `${state}: ${sync.guard.length} notes missing here`;
			return `${state}: ${sync.notSynced.size} not syncing`;
		}
		const unsent = sync?.unsent().length ?? 0;
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
		const problem = this.sync?.vaultProblem() ?? false;
		if (problem && !this.vaultProblemShown) {
			new Notice("SCN Sync: several notes are not available from SCN. Check the vault on Corliss's Notes page.", 0);
		}
		this.vaultProblemShown = problem;
	}

	// The link for a member with no vault. Corliss's Notes page is the only
	// place vaults are made.
	notesPage(): string | null {
		return this.settings.issuer ? `${this.settings.issuer}/notes/` : null;
	}
}
