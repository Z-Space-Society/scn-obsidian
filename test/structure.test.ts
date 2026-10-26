import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { addEntry } from "../src/sync/structure.ts";
import { A, eventually } from "./helpers.ts";
import { connected, plugin, reconnect, relayView, stopAll } from "./setup.ts";

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
