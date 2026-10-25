// Two in-memory repos joined directly stand in for the plugin and the relay.

import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import * as A from "@automerge/automerge/slim";
import {
	NetworkAdapter,
	Repo,
	type DocHandle,
	type Message,
	type PeerId,
	type PeerMetadata,
} from "@automerge/automerge-repo/slim";

// The same start the plugin makes.
await A.initializeBase64Wasm(automergeWasmBase64);

export { A };

class Pipe extends NetworkAdapter {
	other!: Pipe;
	open = false;

	isReady() {
		return true;
	}

	whenReady() {
		return Promise.resolve();
	}

	connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
		this.peerId = peerId;
		this.peerMetadata = peerMetadata ?? {};
		this.open = true;
		if (this.other.open) {
			this.emit("peer-candidate", { peerId: this.other.peerId!, peerMetadata: this.other.peerMetadata ?? {} });
			this.other.emit("peer-candidate", { peerId, peerMetadata: this.peerMetadata });
		}
	}

	send(message: Message) {
		if (!this.open || !this.other.open) return;
		setTimeout(() => this.other.emit("message", message), 0);
	}

	disconnect() {
		if (!this.open) return;
		this.open = false;
		this.emit("peer-disconnected", { peerId: this.other.peerId! });
		this.other.emit("peer-disconnected", { peerId: this.peerId! });
	}
}

export function pipes(): [NetworkAdapter, NetworkAdapter] {
	const a = new Pipe();
	const b = new Pipe();
	a.other = b;
	b.other = a;
	return [a, b];
}

// A repo that, like the relay, never offers a document unasked.
export function relayRepo(adapter: NetworkAdapter): Repo {
	return new Repo({ network: [adapter], shareConfig: { announce: async () => false, access: async () => true } });
}

// Documents in the shape the relay writes (spec D1, D2): every string a
// text object, which a plain string becomes in Automerge 3.
export function note(repo: Repo, name: string, content: string): DocHandle<unknown> {
	return repo.create({ "@patchwork": { type: "file" }, name, extension: "md", mimeType: "text/markdown", content });
}

export function folder(repo: Repo, title: string, entries: Array<[string, DocHandle<unknown>]>): DocHandle<unknown> {
	return repo.create({
		"@patchwork": { type: "folder" },
		title,
		docs: entries.map(([name, handle]) => ({
			name,
			type: name.endsWith(".md") ? "md" : "folder",
			url: handle.url,
		})),
	});
}

export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}
