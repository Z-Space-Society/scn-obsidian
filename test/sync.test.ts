import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Repo } from "@automerge/automerge-repo/slim";
import { MemoryFiles, MemoryNoteStore } from "../src/notes.ts";
import { Sync, copyName } from "../src/sync/sync.ts";
import { eventually, note } from "./helpers.ts";
import { TODAY, append, connected, plugin, relayWithNotes, running, stopAll, textOf } from "./setup.ts";

afterEach(stopAll);

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

describe("outbound", () => {
	it("sends an edit made here to the relay", async () => {
		const { sync, files, hello } = await connected();
		files.files.set("hello.md", "# Hello there\n\nFrom Claude.\n");
		sync.fileChanged("hello.md");
		await eventually(() => textOf(hello) === "# Hello there\n\nFrom Claude.\n", "the edit to reach the relay");
	});

	it("merges an edit here with one made on the relay since the last sync", async () => {
		const { sync, files, hello } = await connected();
		files.files.set("hello.md", "# Hello there\n\nFrom Claude.\n");
		append(hello, "Appended on the relay.\n");
		sync.fileChanged("hello.md");
		const both = "# Hello there\n\nFrom Claude.\nAppended on the relay.\n";
		await eventually(() => textOf(hello) === both && files.files.get("hello.md") === both, "both edits in both places");
	});

	it("merges a local edit not yet sent before writing a relay change", async () => {
		const { files, hello } = await connected();
		// Saved here, with no event yet: the relay's change arrives first.
		files.files.set("hello.md", "# Hi\n\nFrom Claude.\n");
		append(hello, "Arrived first.\n");
		const both = "# Hi\n\nFrom Claude.\nArrived first.\n";
		await eventually(() => textOf(hello) === both && files.files.get("hello.md") === both, "the merge");
	});

	it("does nothing for a save with no change, or for its own write coming back", async () => {
		const { sync, hello, files } = await connected();
		const before = hello.heads();
		sync.fileChanged("hello.md");
		await sync.idle();
		assert.deepEqual(hello.heads(), before);

		append(hello, "From the relay.\n");
		await eventually(() => files.files.get("hello.md")?.endsWith("From the relay.\n") ?? false, "the inbound write");
		const after = hello.heads();
		// The modify event Obsidian fires for that write.
		sync.fileChanged("hello.md");
		await sync.idle();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(hello.heads(), after);
	});

	it("keeps emoji and CRLF exactly", async () => {
		const { sync, files, heat, option } = await connected();
		const heatText = "---\ntags: [art]\n---\nHeat map, warmer\r\nsecond line\r\n";
		const optionText = "Option 2 🚀🛸 and 👩‍💻\n";
		files.files.set("Art Projects/Personal Heat Map.md", heatText);
		files.files.set("Art Projects/Personal Heat Map - Interface Option 2.md", optionText);
		sync.fileChanged("Art Projects/Personal Heat Map.md");
		sync.fileChanged("Art Projects/Personal Heat Map - Interface Option 2.md");
		await eventually(() => textOf(heat) === heatText && textOf(option) === optionText, "both notes on the relay");
	});

	it("ends equal after a burst of saves", async () => {
		const { sync, files, hello } = await connected();
		let text = "# Hello\n\nFrom Claude.\n";
		for (let i = 0; i < 20; i++) {
			text += `line ${i}\n`;
			files.files.set("hello.md", text);
			sync.fileChanged("hello.md");
		}
		await eventually(() => textOf(hello) === text, "the last save on the relay");
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
		files.write = async (path, text, expected) => {
			writes.push(path);
			return write(path, text, expected);
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
