import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { generateAutomergeUrl } from "@automerge/automerge-repo/slim";
import { conflictName } from "../src/schema.ts";
import { addEntry, removeEntry, renameEntry } from "../src/sync/structure.ts";
import { A, eventually, note } from "./helpers.ts";
import { connected, plugin, reconnect, relayView, relayWithNotes, stopAll, textOf } from "./setup.ts";

afterEach(stopAll);

type Setup = Awaited<ReturnType<typeof connected>>;

async function relayHas(setup: Setup, check: (view: Awaited<ReturnType<typeof relayView>>) => boolean, what: string) {
	await eventually(async () => check(await relayView(setup)), what);
}

// What Obsidian does to the files, then the event it sends.
function move(setup: Setup, from: string, to: string) {
	const text = setup.files.files.get(from);
	assert.notEqual(text, undefined, `${from} exists`);
	setup.files.files.delete(from);
	setup.files.files.set(to, text!);
}

function moveFolder(setup: Setup, from: string, to: string) {
	for (const path of [...setup.files.files.keys()]) {
		if (path.startsWith(`${from}/`)) move(setup, path, to + path.slice(from.length));
	}
}

describe("a new note", () => {
	it("uploads with its text exactly", async () => {
		const setup = await connected();
		setup.files.files.set("Laptop Test.md", "# Laptop Test\n\nThis is a test.  Created on Picard.\n");
		setup.sync.created("Laptop Test.md");
		await relayHas(
			setup,
			(view) => view.notes["Laptop Test.md"] === "# Laptop Test\n\nThis is a test.  Created on Picard.\n",
			"the note on the relay",
		);
		await setup.sync.idle();
		assert.deepEqual(setup.sync.unsent(), []);
	});

	it("makes each new folder once", async () => {
		const setup = await connected();
		setup.files.files.set("A/B/one.md", "one\n");
		setup.files.files.set("A/B/two.md", "two\n");
		setup.files.files.set("A/three.md", "three\n");
		for (const path of ["A/B/one.md", "A/B/two.md", "A/three.md"]) setup.sync.created(path);
		await relayHas(setup, (view) => view.notes["A/B/two.md"] === "two\n" && view.notes["A/three.md"] === "three\n", "all three");
		const view = await relayView(setup);
		assert.deepEqual(Object.keys(view.folders).sort(), ["", "A", "A/B", "Art Projects"]);
	});

	it("made while the plugin was not running uploads at the next start", async () => {
		const first = await connected();
		first.sync.stop();
		first.files.files.set("Laptop Test.md", "Created on Picard.\n");
		const second = plugin(first, { files: first.files, store: first.store, network: reconnect(first) });
		await second.sync.start();
		await relayHas({ ...first, ...second }, (view) => view.notes["Laptop Test.md"] === "Created on Picard.\n", "the note");
	});

	it("arrives fifty at a time in one change to their folder, with no duplicates", async () => {
		const setup = await connected();
		for (let i = 0; i < 50; i++) {
			setup.files.files.set(`Bulk/note ${i}.md`, `note ${i}\n`);
			setup.sync.created(`Bulk/note ${i}.md`);
		}
		await relayHas(setup, (view) => Object.keys(view.notes).filter((p) => p.startsWith("Bulk/")).length === 50, "fifty notes");
		const view = await relayView(setup);
		assert.equal(new Set(Object.values(view.urls)).size, Object.keys(view.urls).length);
		assert.deepEqual(view.duplicates, []);
		const bulk = await setup.relay.find<unknown>(view.folders.Bulk as never);
		// Made, then given all fifty entries.
		assert.equal(A.getHistory(bulk.doc() as A.Doc<unknown>).length, 2);
	});

	it("is refused when its name collides with a note on the relay", async () => {
		const setup = await connected();
		setup.files.files.set("HELLO.md", "shouting\n");
		setup.sync.created("HELLO.md");
		await setup.sync.idle();
		assert.ok(setup.sync.notSynced.has("HELLO.md"));
		const view = await relayView(setup);
		assert.equal(view.notes["HELLO.md"], undefined);
		assert.equal(view.notes["hello.md"], "# Hello\n\nFrom Claude.\n");
	});
});

describe("a rename or move", () => {
	it("in place keeps the document and leaves nothing at the old path", async () => {
		const setup = await connected();
		move(setup, "hello.md", "greeting.md");
		setup.sync.renamed("hello.md", "greeting.md", false);
		await relayHas(setup, (view) => view.urls["greeting.md"] === setup.hello.url && !("hello.md" in view.urls), "the rename");
		await setup.sync.idle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(setup.files.files.has("hello.md"), false);
		assert.deepEqual(setup.sync.unsent(), []);
	});

	it("between folders adds to one and removes from the other", async () => {
		const setup = await connected();
		move(setup, "hello.md", "Art Projects/hello.md");
		setup.sync.renamed("hello.md", "Art Projects/hello.md", false);
		await relayHas(
			setup,
			(view) => view.urls["Art Projects/hello.md"] === setup.hello.url && !("hello.md" in view.urls) && view.duplicates.length === 0,
			"the move",
		);
		await setup.sync.idle();
		assert.equal(setup.files.files.has("hello.md"), false);
	});

	for (const order of ["the folder only", "the folder, then its notes", "its notes, then the folder"]) {
		it(`of a folder, reported as ${order}, moves one entry`, async () => {
			const setup = await connected();
			const before = await relayView(setup);
			const notes = ["Personal Heat Map.md", "Personal Heat Map - Interface Option 2.md"];
			moveFolder(setup, "Art Projects", "Art");
			const folderEvent = () => setup.sync.renamed("Art Projects", "Art", true);
			const noteEvents = () => notes.forEach((n) => setup.sync.renamed(`Art Projects/${n}`, `Art/${n}`, false));
			if (order === "its notes, then the folder") noteEvents();
			folderEvent();
			if (order === "the folder, then its notes") noteEvents();
			await relayHas(setup, (view) => view.folders.Art === before.folders["Art Projects"] && !("Art Projects" in view.folders), "the folder rename");
			await setup.sync.idle();
			const after = await relayView(setup);
			assert.equal(Object.keys(after.folders).length, Object.keys(before.folders).length);
			for (const n of notes) assert.equal(after.urls[`Art/${n}`], before.urls[`Art Projects/${n}`]);
			assert.deepEqual(setup.sync.unsent(), []);
			assert.equal([...setup.files.files.keys()].some((p) => p.startsWith("Art Projects/")), false);
		});
	}

	it("to a .txt is a delete, and back to .md a new note", async () => {
		const setup = await connected();
		move(setup, "hello.md", "hello.txt");
		setup.sync.renamed("hello.md", "hello.txt", false);
		await relayHas(setup, (view) => !("hello.md" in view.urls), "the delete");
		move(setup, "hello.txt", "hello.md");
		setup.sync.renamed("hello.txt", "hello.md", false);
		await relayHas(setup, (view) => view.notes["hello.md"] === "# Hello\n\nFrom Claude.\n" && view.urls["hello.md"] !== setup.hello.url, "a new note");
	});

	it("cut short between the add and the remove is finished at the next start", async () => {
		const setup = await connected();
		setup.sync.stop();
		// The add landed: the note is in both folders. The state moved, marked.
		setup.art.change((doc: any) => addEntry(doc, "hello.md", "md", setup.hello.url));
		move(setup, "hello.md", "Art Projects/hello.md");
		const state = setup.store.records.get("hello.md")!;
		setup.store.records.delete("hello.md");
		setup.store.records.set("Art Projects/hello.md", { ...state, path: "Art Projects/hello.md", movedFrom: "hello.md" });

		const again = plugin(setup, { files: setup.files, store: setup.store, network: reconnect(setup) });
		await again.sync.start();
		await relayHas(
			setup,
			(view) => view.urls["Art Projects/hello.md"] === setup.hello.url && !("hello.md" in view.urls) && view.duplicates.length === 0,
			"the move finished",
		);
		await again.sync.idle();
		assert.equal(setup.store.records.get("Art Projects/hello.md")?.movedFrom, undefined);
		assert.equal(setup.files.files.has("hello.md"), false);
	});
});

describe("a delete", () => {
	it("of a note removes its entry, keeps its document, and downloads nothing back", async () => {
		const setup = await connected();
		setup.files.files.delete("hello.md");
		setup.sync.deleted("hello.md", false);
		await relayHas(setup, (view) => !("hello.md" in view.urls), "the entry gone");
		await setup.sync.idle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(setup.files.files.has("hello.md"), false);
		assert.equal(setup.hello.doc() !== undefined, true);
		assert.equal(setup.store.records.has("hello.md"), false);
	});

	it("of a folder removes its one entry", async () => {
		const setup = await connected();
		for (const path of [...setup.files.files.keys()]) if (path.startsWith("Art Projects/")) setup.files.files.delete(path);
		setup.sync.deleted("Art Projects/Personal Heat Map.md", false);
		setup.sync.deleted("Art Projects", true);
		setup.sync.deleted("Art Projects/Personal Heat Map - Interface Option 2.md", false);
		await relayHas(setup, (view) => !("Art Projects" in view.folders), "the folder gone");
		await setup.sync.idle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual([...setup.files.files.keys()], ["hello.md"]);
		// Its own entries are untouched: only the way to it went.
		assert.equal(((setup.art.doc() as any).docs as unknown[]).length, 2);
	});
});

describe("a create event", () => {
	it("for a note the relay already has changes nothing", async () => {
		const setup = await connected();
		setup.sync.created("hello.md");
		await setup.sync.idle();
		const view = await relayView(setup);
		assert.equal(Object.keys(view.urls).length, 3);
	});
});

describe("a change made elsewhere", () => {
	it("renames the file in place, and sends nothing back", async () => {
		const setup = await connected();
		setup.root.change((doc: any) => renameEntry(doc, setup.hello.url, "greeting.md"));
		await eventually(() => setup.files.files.get("greeting.md") === "# Hello\n\nFrom Claude.\n" && !setup.files.files.has("hello.md"), "the rename here");
		await setup.sync.idle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(setup.store.records.get("greeting.md")?.url, setup.hello.url);
		const view = await relayView(setup);
		assert.deepEqual(Object.keys(view.urls).sort(), ["Art Projects/Personal Heat Map - Interface Option 2.md", "Art Projects/Personal Heat Map.md", "greeting.md"]);
		assert.deepEqual(setup.sync.unsent(), []);
	});

	it("moves the file once the old entry goes, and not before", async () => {
		const setup = await connected();
		setup.art.change((doc: any) => addEntry(doc, "hello.md", "md", setup.hello.url));
		await new Promise((resolve) => setTimeout(resolve, 200));
		await setup.sync.idle();
		assert.equal(setup.files.files.has("hello.md"), true);
		assert.equal(setup.files.files.has("Art Projects/hello.md"), false);
		setup.root.change((doc: any) => removeEntry(doc, setup.hello.url));
		await eventually(() => setup.files.files.has("Art Projects/hello.md") && !setup.files.files.has("hello.md"), "the move here");
		await setup.sync.idle();
		const view = await relayView(setup);
		assert.equal(view.urls["Art Projects/hello.md"], setup.hello.url);
		assert.deepEqual(view.duplicates, []);
	});

	it("moves a renamed folder as one, other files with it", async () => {
		const setup = await connected();
		setup.files.files.set("Art Projects/sketch.png", "png");
		setup.root.change((doc: any) => renameEntry(doc, setup.art.url, "Art"));
		await eventually(() => setup.files.files.get("Art/sketch.png") === "png", "the folder here");
		await setup.sync.idle();
		assert.equal([...setup.files.files.keys()].some((p) => p.startsWith("Art Projects/")), false);
		assert.equal(setup.files.files.get("Art/Personal Heat Map.md"), "---\ntags: [art]\n---\nHeat map\r\n");
		const view = await relayView(setup);
		assert.equal(view.folders.Art, setup.art.url);
		assert.equal(Object.keys(view.folders).length, 2);
	});

	it("deletes the file to the trash", async () => {
		const setup = await connected();
		setup.root.change((doc: any) => removeEntry(doc, setup.hello.url));
		await eventually(() => !setup.files.files.has("hello.md"), "the delete here");
		await setup.sync.idle();
		assert.deepEqual(setup.files.trashed, ["hello.md"]);
		assert.equal(setup.store.records.has("hello.md"), false);
		assert.equal("hello.md" in (await relayView(setup)).urls, false);
	});

	it("removes a deleted folder, unless something else is in it", async () => {
		for (const kept of [false, true]) {
			const setup = await connected();
			if (kept) setup.files.files.set("Art Projects/sketch.png", "png");
			setup.root.change((doc: any) => removeEntry(doc, setup.art.url));
			await eventually(() => setup.files.list().length === 1, "the notes gone");
			await setup.sync.idle();
			assert.equal(setup.files.hasFolder("Art Projects"), kept);
			stopAll();
		}
	});

	it("removes a folder deleted after its notes went", async () => {
		const setup = await connected();
		for (const url of [setup.heat.url, setup.option.url]) setup.art.change((doc: any) => removeEntry(doc, url));
		await eventually(() => setup.files.list().length === 1, "the notes gone");
		await setup.sync.idle();
		assert.equal(setup.files.hasFolder("Art Projects"), true);
		setup.root.change((doc: any) => removeEntry(doc, setup.art.url));
		await eventually(() => !setup.files.hasFolder("Art Projects"), "the empty folder gone");
	});

	it("deletes nothing while a folder is unavailable", async () => {
		const setup = await connected();
		setup.root.change((doc: any) => {
			removeEntry(doc, setup.hello.url);
			addEntry(doc, "Elsewhere", "folder", generateAutomergeUrl());
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await setup.sync.idle();
		assert.equal(setup.files.files.has("hello.md"), true);
		assert.equal(setup.store.records.has("hello.md"), true);
	});
});

describe("two notes at one path", () => {
	it("are given the same conflict name by every device", async () => {
		const setup = relayWithNotes();
		const other = note(setup.relay, "Hello.md", "Another hello\n");
		setup.root.change((doc: any) => addEntry(doc, "Hello.md", "md", other.url));
		const [loser, loserName] = other.url < setup.hello.url ? [setup.hello, "hello.md"] : [other, "Hello.md"];
		const conflict = conflictName(loserName, "md", loser.url);
		const first = plugin(setup);
		const second = plugin(setup, { network: reconnect(setup) });
		await Promise.all([first.sync.start(), second.sync.start()]);
		for (const { files } of [first, second]) {
			await eventually(() => files.files.get(conflict) === textOf(loser), "the conflict copy");
		}
		await relayHas({ ...setup, ...first }, (view) => view.urls[conflict] === loser.url, "the rename on the relay");
		await Promise.all([first.sync.idle(), second.sync.idle()]);
		assert.equal(((setup.root.doc() as any).docs as unknown[]).length, 3);
	});

	it("renames the one held here and downloads the other", async () => {
		const setup = await connected();
		let other;
		do other = note(setup.relay, "Hello.md", "Another hello\n");
		while (!(other.url < setup.hello.url));
		setup.files.files.set("hello.md", "# Hello\n\nFrom Claude, edited here.\n");
		setup.sync.fileChanged("hello.md");
		await eventually(() => textOf(setup.hello) === "# Hello\n\nFrom Claude, edited here.\n", "the edit sent");
		setup.root.change((doc: any) => addEntry(doc, "Hello.md", "md", other.url));
		const conflict = conflictName("hello.md", "md", setup.hello.url);
		await eventually(
			() => setup.files.files.get(conflict) === "# Hello\n\nFrom Claude, edited here.\n" && setup.files.files.get("Hello.md") === "Another hello\n",
			"both notes here",
		);
		assert.equal(textOf(other), "Another hello\n");
		assert.equal(textOf(setup.hello), "# Hello\n\nFrom Claude, edited here.\n");
	});
});

describe("a delete made elsewhere against an edit here", () => {
	it("puts the entry back when the edit is not sent yet", async () => {
		const setup = await connected();
		// Saved, with no event yet.
		setup.files.files.set("hello.md", "# Hello\n\nKeep me.\n");
		setup.root.change((doc: any) => removeEntry(doc, setup.hello.url));
		await relayHas(setup, (view) => view.urls["hello.md"] === setup.hello.url && view.notes["hello.md"] === "# Hello\n\nKeep me.\n", "the note back");
		assert.equal(setup.files.files.get("hello.md"), "# Hello\n\nKeep me.\n");
	});

	it("puts the entry back after an edit made offline", async () => {
		const setup = relayWithNotes();
		const local = plugin(setup, { online: () => false });
		await local.sync.start();
		await local.sync.idle();
		local.files.files.set("hello.md", "# Hello\n\nWritten offline.\n");
		local.sync.fileChanged("hello.md");
		await eventually(() => local.store.records.get("hello.md")?.offlineEdit === true, "the offline mark");
		setup.root.change((doc: any) => removeEntry(doc, setup.hello.url));
		await relayHas({ ...setup, ...local }, (view) => view.urls["hello.md"] === setup.hello.url, "the note back");
		await local.sync.idle();
		assert.equal(local.files.files.get("hello.md"), "# Hello\n\nWritten offline.\n");
		assert.deepEqual(local.files.trashed, []);
	});
});
