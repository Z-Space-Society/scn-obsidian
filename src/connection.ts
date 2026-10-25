// The socket to the relay, spec N1, N2 and N4. The plugin owns reconnection:
// the stock adapter would retry the URL it was given, and that URL carries a
// token that expires.

import type { Repo } from "@automerge/automerge-repo/slim";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { Offline, SignedOut, REFRESH_MARGIN_MS, type TokenKeeper } from "./auth.ts";

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
// Longer than any connection lives, so the adapter's own retry interval
// never fires. Zero would not do: the adapter would reconnect every tick.
const NO_RETRY = 2 ** 31 - 1;

export type ConnectionState = "connecting" | "online" | "offline" | "signed out" | "stopped";

// The stock adapter, minus its retry on close: a close is reported instead,
// and the plugin opens a new adapter with a fresh token.
class RelayAdapter extends WebSocketClientAdapter {
	closed: () => void = () => {};

	onClose = () => {
		if (this.remotePeerId) this.emit("peer-disconnected", { peerId: this.remotePeerId });
		this.closed();
	};
}

export function socketUrl(syncUrl: string, token: string): string {
	return `${syncUrl.replace(/^https:/, "wss:")}/?access_token=${encodeURIComponent(token)}`;
}

export interface ConnectionOptions {
	repo: Repo;
	syncUrl: string;
	keeper: TokenKeeper;
	onState: (state: ConnectionState) => void;
}

export class Connection {
	state: ConnectionState = "connecting";
	private options: ConnectionOptions;
	private adapter: RelayAdapter | null = null;
	private attempt = 0;
	private timer: number | null = null;
	private renewTimer: number | null = null;

	constructor(options: ConnectionOptions) {
		this.options = options;
	}

	start() {
		void this.open();
	}

	stop() {
		this.clearTimers();
		this.drop();
		this.set("stopped");
	}

	// N4. On return to the foreground the socket is assumed dead: on the
	// iPhone readyState still said OPEN on a socket closed a moment later.
	resume() {
		if (this.state === "stopped" || this.state === "signed out") return;
		this.reopen();
	}

	private set(state: ConnectionState) {
		this.state = state;
		this.options.onState(state);
	}

	private clearTimers() {
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.renewTimer !== null) window.clearTimeout(this.renewTimer);
		this.timer = this.renewTimer = null;
	}

	private drop() {
		const adapter = this.adapter;
		this.adapter = null;
		if (adapter) this.options.repo.networkSubsystem.removeNetworkAdapter(adapter);
	}

	// Closes first, then opens. The repo keeps one adapter per remote peer
	// and the relay's peer ID does not change, so a new socket opened beside
	// the old one would be ignored and the relay lost when the old one goes.
	private reopen() {
		this.clearTimers();
		this.drop();
		this.attempt = 0;
		void this.open();
	}

	private async open() {
		this.set("connecting");
		let token: string;
		try {
			token = await this.options.keeper.accessToken();
		} catch (e) {
			if (e instanceof SignedOut) {
				this.set("signed out");
				return;
			}
			if (!(e instanceof Offline)) console.error("SCN Sync: getting a token failed", e);
			this.retry();
			return;
		}
		if (this.state === "stopped") return;

		const adapter = new RelayAdapter(socketUrl(this.options.syncUrl, token), NO_RETRY);
		adapter.closed = () => {
			if (this.adapter !== adapter) return;
			this.drop();
			this.retry();
		};
		adapter.on("peer-candidate", () => {
			if (this.adapter !== adapter) return;
			this.attempt = 0;
			this.set("online");
		});
		this.adapter = adapter;
		this.options.repo.networkSubsystem.addNetworkAdapter(adapter);
		this.scheduleRenewal();
	}

	private retry() {
		if (this.state === "stopped" || this.state === "signed out") return;
		this.set("offline");
		const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
		this.attempt++;
		this.clearTimers();
		this.timer = window.setTimeout(() => void this.open(), delay);
	}

	// N2. The relay closes the socket at the token's `exp`. The plugin moves
	// to a fresh token just under a minute before, inside the keeper's
	// margin, so the token it then asks for is a new one.
	private scheduleRenewal() {
		const expiresAt = this.options.keeper.expiresAt();
		if (expiresAt === null) return;
		const delay = Math.max(expiresAt - REFRESH_MARGIN_MS + 1000 - Date.now(), 0);
		if (this.renewTimer !== null) window.clearTimeout(this.renewTimer);
		this.renewTimer = window.setTimeout(() => this.reopen(), delay);
	}
}
