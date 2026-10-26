// The plugin against a relay holding what Jacob's vault holds, for the sync
// and structure tests.

import { Repo, type DocHandle, type NetworkAdapter } from "@automerge/automerge-repo/slim";
import { MemoryFiles, MemoryNoteStore } from "../src/notes.ts";
import { noteText } from "../src/schema.ts";
import { Sync, type Plan } from "../src/sync/sync.ts";
import { walk } from "../src/tree.ts";
import { A, folder, note, pipes, relayRepo } from "./helpers.ts";

export const TODAY = "2026-10-24";
export const running: Sync[] = [];

export function stopAll() {
	for (const sync of running.splice(0)) sync.stop();
}

// The relay holding what Jacob's vault holds: one note at the top and two in
// a folder, all written over MCP.
export function relayWithNotes() {
	const [pluginEnd, relayEnd] = pipes();
	const relay = relayRepo(relayEnd);
	const hello = note(relay, "hello.md", "# Hello\n\nFrom Claude.\n");
	const heat = note(relay, "Personal Heat Map.md", "---\ntags: [art]\n---\nHeat map\r\n");
	const option = note(relay, "Personal Heat Map - Interface Option 2.md", "Option 2 🚀\n");
	const art = folder(relay, "Art Projects", [
		["Personal Heat Map.md", heat],
		["Personal Heat Map - Interface Option 2.md", option],
	]);
	const root = folder(relay, "SCN Notes", [
		["Art Projects", art],
		["hello.md", hello],
	]);
	return { relay, pluginEnd, root, hello, heat, option, art };
}

export function plugin(
	setup: ReturnType<typeof relayWithNotes>,
	options: {
		files?: MemoryFiles;
		store?: MemoryNoteStore;
		confirm?: (plan: Plan) => Promise<boolean>;
		network?: NetworkAdapter;
	} = {},
) {
	const repo = new Repo({ network: [options.network ?? setup.pluginEnd] });
	const files = options.files ?? new MemoryFiles();
	const store = options.store ?? new MemoryNoteStore();
	const plans: Plan[] = [];
	const sync = new Sync({
		repo,
		rootUrl: setup.root.url,
		files,
		store,
		confirm: options.confirm ?? (async (plan) => (plans.push(plan), true)),
		onStatus: () => {},
		today: () => TODAY,
	});
	running.push(sync);
	return { sync, files, store, plans, repo };
}

export function append(handle: DocHandle<unknown>, text: string) {
	handle.change((doc: any) => A.splice(doc, ["content"], doc.content.length, 0, text));
}

export async function connected() {
	const setup = relayWithNotes();
	const local = plugin(setup);
	await local.sync.start();
	await local.sync.idle();
	return { ...setup, ...local };
}

export function textOf(handle: DocHandle<unknown>): string | null {
	return noteText(handle.doc());
}


// A second connection to the same relay, for a plugin started again.
export function reconnect(setup: ReturnType<typeof relayWithNotes>): NetworkAdapter {
	const [pluginEnd, relayEnd] = pipes();
	setup.relay.networkSubsystem.addNetworkAdapter(relayEnd);
	return pluginEnd;
}

// The relay's own view of the vault: path to text, and the folder paths.
export async function relayView(setup: ReturnType<typeof relayWithNotes>) {
	const open = async (url: string) => {
		const handle = await setup.relay.find<unknown>(url as never, { allowableStates: ["ready", "unavailable"] });
		return handle.isReady() ? handle.doc() : null;
	};
	const tree = await walk(open, setup.root.url);
	const notes: Record<string, string | null> = {};
	for (const [path, url] of tree.notes) notes[path] = noteText(await open(url));
	return { notes, urls: Object.fromEntries(tree.notes), folders: Object.fromEntries(tree.folders), duplicates: tree.duplicates };
}
