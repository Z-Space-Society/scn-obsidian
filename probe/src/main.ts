import {
	App,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	apiVersion,
	requestUrl,
} from "obsidian";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import * as Automerge from "@automerge/automerge/slim";
import { Repo } from "@automerge/automerge-repo/slim";

// The real plugin's redirect URI is obsidian://scn-obsidian, so the probe
// registers that exact action. Disable the probe before installing SCN Sync.
const PROTOCOL_ACTION = "scn-obsidian";
const SECRET_ID = "scn-sync-probe-test";
const IDB_NAME = "scn-sync-probe";
const IDB_STORE = "kv";
const LOCAL_STORAGE_KEY = "scn-sync-probe-marker";
const MAX_LOG_LINES = 300;

interface CallbackRecord {
	at: string;
	state: string | null;
	code: string | null;
	// True when the state matches a sign-in this vault started.
	matched: boolean;
	// Small values mean the callback itself started Obsidian.
	msSincePluginLoad: number;
}

interface ProbeData {
	redirectBase: string;
	socketUrl: string;
	enabledAt: string[];
	loads: string[];
	pendingState: { state: string; startedAt: string } | null;
	callbacks: CallbackRecord[];
	idbMarkerWrittenAt: string | null;
	localStorageMarkerWrittenAt: string | null;
	secretWrittenAt: string | null;
	secretValue: string | null;
	results: Record<string, unknown>;
	socketLog: string[];
}

const DEFAULT_DATA: ProbeData = {
	redirectBase: "https://httpbin.org/redirect-to?url=",
	socketUrl: "wss://echo.websocket.org",
	enabledAt: [],
	loads: [],
	pendingState: null,
	callbacks: [],
	idbMarkerWrittenAt: null,
	localStorageMarkerWrittenAt: null,
	secretWrittenAt: null,
	secretValue: null,
	results: {},
	socketLog: [],
};

function now(): string {
	return new Date().toISOString();
}

function age(iso: string | null): string | null {
	if (!iso) return null;
	const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
	if (s < 120) return `${s}s`;
	if (s < 7200) return `${Math.round(s / 60)}m`;
	if (s < 172800) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

function errText(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idbOpen(): Promise<IDBDatabase> {
	const req = indexedDB.open(IDB_NAME, 1);
	req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
	return idbRequest(req);
}

export default class ScnSyncProbe extends Plugin {
	data: ProbeData = { ...DEFAULT_DATA };
	loadedAt = Date.now();
	socket: WebSocket | null = null;
	wasmReady = false;
	private lastBeat = Date.now();
	private echoWaiter: ((ok: boolean) => void) | null = null;
	private saveTimer: number | null = null;
	onChange: (() => void) | null = null;

	async onload() {
		this.loadedAt = Date.now();
		this.data = { ...DEFAULT_DATA, ...((await this.loadData()) ?? {}) };
		this.data.loads = [...this.data.loads, now()].slice(-20);
		await this.saveData(this.data);

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			const pending = this.data.pendingState;
			const record: CallbackRecord = {
				at: now(),
				state: params.state ?? null,
				code: params.code ?? null,
				matched: !!pending && pending.state === params.state,
				msSincePluginLoad: Date.now() - this.loadedAt,
			};
			this.data.callbacks = [...this.data.callbacks, record].slice(-20);
			if (record.matched) this.data.pendingState = null;
			void this.saveData(this.data);
			new Notice(
				`SCN probe: callback received, state ${record.matched ? "matched" : "did NOT match"}`,
				0,
			);
			this.onChange?.();
		});

		this.addSettingTab(new ProbeSettingTab(this.app, this));
		this.addRibbonIcon("flask-conical", "SCN Sync probe", () => {
			new Notice("SCN Sync probe: open Settings, then SCN Sync Probe.");
		});

		this.registerDomEvent(document, "visibilitychange", () => {
			this.log(`visibility ${document.visibilityState}`);
			if (document.visibilityState === "visible" && this.socket) {
				void this.checkSocketAlive("on resume");
			}
		});

		// A frozen app shows up as a gap between beats.
		this.registerInterval(
			window.setInterval(() => {
				const gap = Date.now() - this.lastBeat;
				if (gap > 6000 && this.socket) {
					this.log(`timer gap ${Math.round(gap / 1000)}s (app was frozen)`);
				}
				this.lastBeat = Date.now();
			}, 2000),
		);
	}

	onunload() {
		this.socket?.close();
	}

	onUserEnable() {
		this.data.enabledAt = [...this.data.enabledAt, now()].slice(-20);
		void this.saveData(this.data);
		new Notice("SCN Sync probe: onUserEnable fired. Open the probe's settings.", 0);
	}

	log(line: string) {
		this.data.socketLog = [...this.data.socketLog, `${now()} ${line}`].slice(-MAX_LOG_LINES);
		if (this.saveTimer === null) {
			this.saveTimer = window.setTimeout(() => {
				this.saveTimer = null;
				void this.saveData(this.data);
			}, 500);
		}
		this.onChange?.();
	}

	async record(name: string, result: unknown) {
		this.data.results[name] = { at: now(), result };
		await this.saveData(this.data);
		this.onChange?.();
	}

	environment(): Record<string, unknown> {
		const adapter = this.app.vault.adapter;
		let vaultPath: string | null = null;
		try {
			if (adapter instanceof FileSystemAdapter) vaultPath = adapter.getBasePath();
			else vaultPath = (adapter as unknown as { getFullPath(p: string): string }).getFullPath("");
		} catch (e) {
			vaultPath = `error: ${errText(e)}`;
		}
		return {
			obsidianApiVersion: apiVersion,
			userAgent: navigator.userAgent,
			platform: {
				isDesktopApp: Platform.isDesktopApp,
				isMobileApp: Platform.isMobileApp,
				isIosApp: Platform.isIosApp,
				isPhone: Platform.isPhone,
				isTablet: Platform.isTablet,
			},
			origin: location.origin,
			adapterClass: adapter.constructor?.name,
			vaultName: this.app.vault.getName(),
			vaultPath,
			looksLikeICloud: !!vaultPath && /Mobile Documents|iCloud/i.test(vaultPath),
			configDir: this.app.vault.configDir,
			pluginDir: this.manifest.dir,
			markdownFiles: this.app.vault.getMarkdownFiles().length,
			allFiles: this.app.vault.getFiles().length,
			hasSecretStorage: !!this.app.secretStorage,
			hasWebAssembly: typeof WebAssembly !== "undefined",
			pluginLoads: this.data.loads,
			onUserEnableFired: this.data.enabledAt,
		};
	}

	async testStorage() {
		const out: Record<string, unknown> = {};
		try {
			out.persistedBefore = await navigator.storage?.persisted?.();
			out.persistGranted = await navigator.storage?.persist?.();
			out.estimate = await navigator.storage?.estimate?.();
		} catch (e) {
			out.storageApiError = errText(e);
		}

		try {
			const db = await idbOpen();
			const read = db.transaction(IDB_STORE).objectStore(IDB_STORE).get("marker");
			const marker = (await idbRequest(read)) as string | undefined;
			if (marker) {
				out.indexedDb = `marker present, written ${age(marker)} ago`;
			} else if (this.data.idbMarkerWrittenAt) {
				out.indexedDb = `LOST: marker written ${age(this.data.idbMarkerWrittenAt)} ago is gone`;
			} else {
				out.indexedDb = "no marker yet, writing one now";
			}
			if (!marker) {
				const stamp = now();
				const tx = db.transaction(IDB_STORE, "readwrite");
				await idbRequest(tx.objectStore(IDB_STORE).put(stamp, "marker"));
				this.data.idbMarkerWrittenAt = stamp;
			}
			db.close();
		} catch (e) {
			out.indexedDb = `error: ${errText(e)}`;
		}

		try {
			const marker = this.app.loadLocalStorage(LOCAL_STORAGE_KEY) as string | null;
			if (marker) {
				out.localStorage = `marker present, written ${age(marker)} ago`;
			} else if (this.data.localStorageMarkerWrittenAt) {
				out.localStorage = `LOST: marker written ${age(this.data.localStorageMarkerWrittenAt)} ago is gone`;
			} else {
				out.localStorage = "no marker yet, writing one now";
			}
			if (!marker) {
				const stamp = now();
				this.app.saveLocalStorage(LOCAL_STORAGE_KEY, stamp);
				this.data.localStorageMarkerWrittenAt = stamp;
			}
		} catch (e) {
			out.localStorage = `error: ${errText(e)}`;
		}

		await this.record("storage", out);
	}

	async testSecret() {
		const out: Record<string, unknown> = {};
		const store = this.app.secretStorage;
		if (!store) {
			await this.record("secret", { error: "app.secretStorage is missing (needs Obsidian 1.11.4)" });
			return;
		}
		try {
			const existing = store.getSecret(SECRET_ID);
			if (existing) {
				out.secret =
					existing === this.data.secretValue
						? `present and unchanged, written ${age(this.data.secretWrittenAt)} ago`
						: "present but value differs from what the probe wrote";
			} else if (this.data.secretWrittenAt) {
				out.secret = `LOST: secret written ${age(this.data.secretWrittenAt)} ago is gone`;
			} else {
				out.secret = "no secret yet, writing one now";
			}
			if (!existing) {
				const value = `probe-${randomToken()}`;
				store.setSecret(SECRET_ID, value);
				this.data.secretValue = value;
				this.data.secretWrittenAt = now();
				out.readBack = store.getSecret(SECRET_ID) === value;
			}
			out.listed = store.listSecrets().includes(SECRET_ID);
			// Tells us whether the store is plain webview localStorage or something else.
			const value = this.data.secretValue;
			let inLocalStorage = false;
			if (value) {
				for (let i = 0; i < localStorage.length; i++) {
					const key = localStorage.key(i);
					if (key && (localStorage.getItem(key) ?? "").includes(value)) inLocalStorage = true;
				}
			}
			out.valueVisibleInWebviewLocalStorage = inLocalStorage;
		} catch (e) {
			out.error = errText(e);
		}
		await this.record("secret", out);
	}

	async testHttp() {
		// A page that sends no CORS headers, so an enforced policy makes fetch fail.
		const url = "https://example.com/";
		const out: Record<string, unknown> = {};
		try {
			const res = await fetch(url);
			out.fetch = `status ${res.status}`;
		} catch (e) {
			out.fetch = `failed: ${errText(e)}`;
		}
		try {
			const res = await requestUrl({ url, throw: false });
			out.requestUrl = `status ${res.status}`;
		} catch (e) {
			out.requestUrl = `failed: ${errText(e)}`;
		}
		await this.record("http", out);
	}

	async testWasm() {
		const out: Record<string, unknown> = {
			wasmBase64Chars: automergeWasmBase64.length,
			alreadyInitialised: this.wasmReady,
		};
		try {
			if (!this.wasmReady) {
				const t0 = performance.now();
				await Automerge.initializeBase64Wasm(automergeWasmBase64);
				out.initMs = Math.round(performance.now() - t0);
				this.wasmReady = true;
			}

			const t1 = performance.now();
			let doc = Automerge.from<{ text: string }>({ text: "" });
			for (let i = 0; i < 1000; i++) {
				doc = Automerge.change(doc, (d) => {
					Automerge.splice(d, ["text"], d.text.length, 0, `line ${i}\n`);
				});
			}
			out.thousandSplicesMs = Math.round(performance.now() - t1);
			out.savedBytes = Automerge.save(doc).byteLength;
			out.textLength = doc.text.length;

			const t2 = performance.now();
			const repo = new Repo({});
			const handle = repo.create<{ text: string }>({ text: "hello" });
			out.repoCreateMs = Math.round(performance.now() - t2);
			out.repoDocUrl = handle.url;
		} catch (e) {
			out.error = errText(e);
		}
		await this.record("wasm", out);
	}

	async startSignInTest(): Promise<string> {
		const state = randomToken();
		// Saved before the browser opens: iOS may end Obsidian while Safari is in front.
		this.data.pendingState = { state, startedAt: now() };
		await this.saveData(this.data);
		const callback = `obsidian://${PROTOCOL_ACTION}?code=probe-code&state=${state}`;
		return this.data.redirectBase + encodeURIComponent(callback);
	}

	startSocket() {
		this.socket?.close();
		this.log(`connecting ${this.data.socketUrl}`);
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.data.socketUrl);
		} catch (e) {
			this.log(`constructor threw ${errText(e)}`);
			return;
		}
		this.socket = ws;
		ws.onopen = () => this.log("open");
		ws.onerror = () => this.log("error event");
		ws.onclose = (ev) => {
			this.log(`close code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || "-"}`);
			if (this.socket === ws) this.socket = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data === "string" && ev.data.startsWith("probe-ping") && this.echoWaiter) {
				this.echoWaiter(true);
			}
		};
	}

	stopSocket() {
		this.log("closing by request");
		this.socket?.close();
		this.socket = null;
	}

	async checkSocketAlive(why: string) {
		const ws = this.socket;
		if (!ws) {
			this.log(`${why}: no socket`);
			return;
		}
		const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
		const readyState = states[ws.readyState];
		if (ws.readyState !== WebSocket.OPEN) {
			this.log(`${why}: readyState ${readyState}`);
			return;
		}
		const echoed = await new Promise<boolean>((resolve) => {
			const timer = window.setTimeout(() => resolve(false), 4000);
			this.echoWaiter = (ok) => {
				window.clearTimeout(timer);
				resolve(ok);
			};
			try {
				ws.send(`probe-ping ${Date.now()}`);
			} catch {
				window.clearTimeout(timer);
				resolve(false);
			}
		});
		this.echoWaiter = null;
		this.log(`${why}: readyState ${readyState}, echo ${echoed ? "returned (ALIVE)" : "timed out (DEAD)"}`);
	}

	report(): string {
		return JSON.stringify(
			{
				generatedAt: now(),
				probeVersion: this.manifest.version,
				environment: this.environment(),
				results: this.data.results,
				pendingSignIn: this.data.pendingState,
				callbacks: this.data.callbacks,
				socketLog: this.data.socketLog.slice(-80),
			},
			null,
			2,
		);
	}
}

class ProbeSettingTab extends PluginSettingTab {
	plugin: ScnSyncProbe;
	private reportEl: HTMLElement | null = null;

	constructor(app: App, plugin: ScnSyncProbe) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide() {
		this.plugin.onChange = null;
	}

	display() {
		const { containerEl, plugin } = this;
		containerEl.empty();
		plugin.onChange = () => this.reportEl?.setText(plugin.report());

		const run = (fn: () => Promise<void> | void) => async () => {
			try {
				await fn();
			} catch (e) {
				new Notice(`SCN probe: ${errText(e)}`, 0);
			}
			plugin.onChange?.();
		};

		new Setting(containerEl)
			.setName("Copy report")
			.setDesc("Copies everything below as JSON. Paste it back to pawl.")
			.addButton((b) =>
				b.setButtonText("Copy").setCta().onClick(
					run(async () => {
						await navigator.clipboard.writeText(plugin.report());
						new Notice("SCN probe: report copied");
					}),
				),
			);

		new Setting(containerEl).setName("1. Storage").setHeading();
		new Setting(containerEl)
			.setName("Storage durability")
			.setDesc(
				"Asks for persistent storage and checks markers in IndexedDB and local storage. Run it now, then again after days, after a restart, and after the phone has been low on space.",
			)
			.addButton((b) => b.setButtonText("Run").onClick(run(() => plugin.testStorage())));
		new Setting(containerEl)
			.setName("Secret storage")
			.setDesc("Writes a throwaway secret, reads it back, and checks where it is kept.")
			.addButton((b) => b.setButtonText("Run").onClick(run(() => plugin.testSecret())));

		new Setting(containerEl).setName("2. Sign-in return").setHeading();
		new Setting(containerEl)
			.setName("Redirect service")
			.setDesc("A URL prefix that answers 302 to the encoded address appended to it.")
			.addText((t) =>
				t.setValue(plugin.data.redirectBase).onChange(async (v) => {
					plugin.data.redirectBase = v.trim();
					await plugin.saveData(plugin.data);
				}),
			);
		const linkHolder = containerEl.createDiv();
		new Setting(containerEl)
			.setName("A. Open the browser from code")
			.setDesc("Calls window.open on a page that redirects straight back to Obsidian.")
			.addButton((b) =>
				b.setButtonText("Open").onClick(
					run(async () => {
						const url = await plugin.startSignInTest();
						const opened = window.open(url);
						await plugin.record("openBrowser", { windowOpenReturned: opened === null ? "null" : typeof opened });
					}),
				),
			);
		new Setting(containerEl)
			.setName("B. Open the browser from a link")
			.setDesc("Makes a plain link below. Tap it. Use this if A does nothing.")
			.addButton((b) =>
				b.setButtonText("Make link").onClick(
					run(async () => {
						const url = await plugin.startSignInTest();
						linkHolder.empty();
						linkHolder.createEl("a", { text: "Tap here to start the sign-in return test", href: url });
					}),
				),
			);
		new Setting(containerEl)
			.setName("C. Return to a closed Obsidian")
			.setDesc(
				"Copies the test address. Then swipe Obsidian away in the app switcher, paste the address into Safari, and go.",
			)
			.addButton((b) =>
				b.setButtonText("Copy address").onClick(
					run(async () => {
						await navigator.clipboard.writeText(await plugin.startSignInTest());
						new Notice("SCN probe: address copied. Close Obsidian, then paste it into Safari.", 0);
					}),
				),
			);

		new Setting(containerEl).setName("3. Network").setHeading();
		new Setting(containerEl)
			.setName("fetch against requestUrl")
			.setDesc("Shows whether plain fetch is blocked where requestUrl is not.")
			.addButton((b) => b.setButtonText("Run").onClick(run(() => plugin.testHttp())));
		new Setting(containerEl)
			.setName("Socket address")
			.setDesc("Any echo server over wss.")
			.addText((t) =>
				t.setValue(plugin.data.socketUrl).onChange(async (v) => {
					plugin.data.socketUrl = v.trim();
					await plugin.saveData(plugin.data);
				}),
			);
		new Setting(containerEl)
			.setName("Socket across backgrounding")
			.setDesc(
				"Connect, leave Obsidian for 10 seconds, come back. Repeat for 1 minute, 5 minutes and with the screen locked. The log records what the socket did each time.",
			)
			.addButton((b) => b.setButtonText("Connect").onClick(run(() => plugin.startSocket())))
			.addButton((b) => b.setButtonText("Check").onClick(run(() => plugin.checkSocketAlive("manual check"))))
			.addButton((b) => b.setButtonText("Close").onClick(run(() => plugin.stopSocket())));

		new Setting(containerEl).setName("4. Automerge").setHeading();
		new Setting(containerEl)
			.setName("WASM load time")
			.setDesc(
				"Loads Automerge from the inlined WASM and times it. The first run after starting Obsidian is the number that matters.",
			)
			.addButton((b) => b.setButtonText("Run").onClick(run(() => plugin.testWasm())));

		new Setting(containerEl).setName("Report").setHeading();
		new Setting(containerEl)
			.setName("Clear results")
			.setDesc("Clears results and the log. Keeps the storage and secret markers.")
			.addButton((b) =>
				b.setButtonText("Clear").onClick(
					run(async () => {
						plugin.data.results = {};
						plugin.data.socketLog = [];
						plugin.data.callbacks = [];
						await plugin.saveData(plugin.data);
					}),
				),
			);
		this.reportEl = containerEl.createEl("pre", { text: plugin.report() });
		this.reportEl.style.whiteSpace = "pre-wrap";
		this.reportEl.style.wordBreak = "break-all";
		this.reportEl.style.fontSize = "var(--font-smallest)";
		this.reportEl.style.userSelect = "text";
	}
}
