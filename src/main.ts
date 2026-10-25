import { Notice, Plugin, requestUrl } from "obsidian";
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
import { describe } from "./messages.ts";
import { listVaults, type Vault } from "./relay.ts";
import { DEFAULT_SETTINGS, signedInAsSomeoneElse, type Settings } from "./state.ts";
import { ScnSyncSettingTab } from "./ui/settings.ts";
import { SetupModal, VaultPickModal } from "./ui/setup.ts";

const PENDING_KEY = "scn-sync-pending-sign-in";
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

export default class ScnSync extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	keeper!: TokenKeeper;
	// Set by whichever settings screen is showing, so a sign-in finishing in
	// the background redraws it.
	onChange: (() => void) | null = null;

	async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
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
		this.addSettingTab(new ScnSyncSettingTab(this.app, this));
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

	// S1 and S2. Opens the browser at Corliss.
	async startSignIn(input: string) {
		const syncUrl = normaliseSyncUrl(input);
		const endpoints = await discover(http, syncUrl, this.settings.issuerOverride.trim() || undefined);
		const { pending, url } = await beginSignIn(endpoints, syncUrl, Date.now());
		this.app.saveLocalStorage(PENDING_KEY, pending);
		window.open(url);
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
			if (!this.settings.vaultUrl) new VaultPickModal(this.app, this).open();
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
		new Notice(`SCN Sync: connected to ${vault.name}.`);
	}

	// Keeps every file. Choosing another vault is a disconnect, then a connect.
	async disconnect() {
		this.settings.vaultUrl = "";
		this.settings.vaultName = "";
		await this.save();
	}

	// S6. Local files are kept.
	signOut() {
		this.keeper.signOut();
		this.onChange?.();
	}

	// The link for a member with no vault. Corliss's Notes page is the only
	// place vaults are made.
	notesPage(): string | null {
		return this.settings.issuer ? `${this.settings.issuer}/notes/` : null;
	}
}
