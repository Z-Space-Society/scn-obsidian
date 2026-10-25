import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Repo, type DocHandle } from "@automerge/automerge-repo/slim";
import { MemoryFiles, MemoryNoteStore } from "../src/notes.ts";
import { Sync, copyName, type Plan } from "../src/sync/sync.ts";
import { A, eventually, folder, note, pipes, relayRepo } from "./helpers.ts";

const TODAY = "2026-10-24";
let running: Sync[] = [];

afterEach(() => {
	for (const sync of running) sync.stop();
	running = [];
});

// The relay holding what Jacob's vault holds: one note at the top and two in
// a folder, all written over MCP.
function relayWithNotes() {
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

function plugin(
	setup: ReturnType<typeof relayWithNotes>,
	options: { files?: MemoryFiles; store?: MemoryNoteStore; confirm?: (plan: Plan) => Promise<boolean> } = {},
) {
	const repo = new Repo({ network: [setup.pluginEnd] });
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

function append(handle: DocHandle<unknown>, text: string) {
	handle.change((doc: any) => A.splice(doc, ["content"], doc.content.length, 0, text));
}

describe("the first connect", () => {
	it("downloads the relay's notes byte for byte, folders included", async () => {
		const setup = relayWithNotes();
		const { sync, files, plans } = plugin(setup);
		await sync.start();
		await sync.idle();
		assert.deepEqual(Object.fromEntries(files.files), {
			"hello.md": "# Hello\n\nFrom Claude.\n",
			"Art Projects/Personal Heat Map.md": "---\ntags: [art]\n---\nHeat map\r\n",
			"Art Projects/Personal Heat Map - Interface Option 2.md": "Option 2 🚀\n",
		});
		assert.equal(plans.length, 1);
		assert.equal(plans[0].download.length, 3);
		assert.equal(sync.connected, true);
	});

	it("writes nothing when the member declines", async () => {
		const setup = relayWithNotes();
		const { sync, files, store } = plugin(setup, { confirm: async () => false });
		await sync.start();
		await sync.idle();
		assert.equal(files.files.size, 0);
		assert.equal(store.records.size, 0);
		assert.equal(sync.declined, true);
	});

	it("adopts a matching file and keeps a differing one as a copy", async () => {
		const setup = relayWithNotes();
		const files = new MemoryFiles();
		files.files.set("hello.md", "# Hello\n\nFrom Claude.\n");
		files.files.set("Art Projects/Personal Heat Map.md", "my own version\n");
		files.files.set("mine.md", "only here\n");
		const { sync, plans } = plugin(setup, { files });
		await sync.start();
		await sync.idle();
		assert.deepEqual(plans[0].adopt, ["hello.md"]);
		assert.deepEqual(plans[0].copy, ["Art Projects/Personal Heat Map.md"]);
		assert.deepEqual(plans[0].localOnly, ["mine.md"]);
		assert.equal(files.files.get("Art Projects/Personal Heat Map (local copy 2026-10-24).md"), "my own version\n");
		assert.equal(files.files.get("Art Projects/Personal Heat Map.md"), "---\ntags: [art]\n---\nHeat map\r\n");
		assert.equal(files.files.get("mine.md"), "only here\n");
	});
});

describe("inbound", () => {
	it("writes a change made on the relay, as an MCP append is", async () => {
		const setup = relayWithNotes();
		const { sync, files } = plugin(setup);
		await sync.start();
		await sync.idle();
		append(setup.hello, "Appended later.\n");
		await eventually(
			() => files.files.get("hello.md") === "# Hello\n\nFrom Claude.\nAppended later.\n",
			"the append to reach the file",
		);
	});

	it("holds back a change to a note edited here, and keeps the edit", async () => {
		const setup = relayWithNotes();
		const { sync, files } = plugin(setup);
		await sync.start();
		await sync.idle();
		files.files.set("hello.md", "edited locally\n");
		append(setup.hello, "From the relay.\n");
		await eventually(() => sync.notSynced.has("hello.md"), "the note to be held back");
		assert.equal(files.files.get("hello.md"), "edited locally\n");
	});

	it("counts a note made here as not uploaded", async () => {
		const setup = relayWithNotes();
		const { sync, files } = plugin(setup);
		await sync.start();
		await sync.idle();
		assert.deepEqual(sync.unsent(), []);
		files.files.set("Laptop Test.md", "Created on Picard.\n");
		assert.deepEqual(sync.unsent(), ["Laptop Test.md"]);
	});

	it("downloads a note created on the relay after connecting", async () => {
		const setup = relayWithNotes();
		const { sync, files } = plugin(setup);
		await sync.start();
		await sync.idle();
		const fresh = note(setup.relay, "new.md", "brand new\n");
		setup.art.change((doc: any) => {
			doc.docs.push({ name: "new.md", type: "md", url: fresh.url });
		});
		await eventually(() => files.files.get("Art Projects/new.md") === "brand new\n", "the new note");
	});
});

describe("starting offline", () => {
	it("downloads once a connection opens after the walk began", async () => {
		const setup = relayWithNotes();
		const repo = new Repo({ network: [] });
		const files = new MemoryFiles();
		const sync = new Sync({
			repo,
			rootUrl: setup.root.url,
			files,
			store: new MemoryNoteStore(),
			confirm: async () => true,
			onStatus: () => {},
			today: () => TODAY,
		});
		running.push(sync);
		await sync.start();
		assert.equal(files.files.size, 0);
		repo.networkSubsystem.addNetworkAdapter(setup.pluginEnd);
		await eventually(() => files.files.size === 3, "the late download");
	});
});

describe("a lost store", () => {
	it("runs the connect procedure again and rewrites nothing that matches", async () => {
		const setup = relayWithNotes();
		const first = plugin(setup);
		await first.sync.start();
		await first.sync.idle();
		first.sync.stop();

		const files = first.files;
		const writes: string[] = [];
		const write = files.write.bind(files);
		files.write = async (path, text) => {
			writes.push(path);
			await write(path, text);
		};
		const second = plugin(setup, { files, store: new MemoryNoteStore() });
		await second.sync.start();
		await second.sync.idle();
		assert.equal(second.plans[0].adopt.length, 3);
		assert.deepEqual(writes, []);
		assert.equal(second.store.records.size, 3);
	});
});

describe("copy names", () => {
	it("sits beside the original", () => {
		assert.equal(copyName("a/b/Note.md", TODAY), "a/b/Note (local copy 2026-10-24).md");
		assert.equal(copyName("Note.md", TODAY, 2), "Note (local copy 2026-10-24 2).md");
	});
});
