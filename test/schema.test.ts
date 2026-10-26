import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictName, entriesOf, noteText, str } from "../src/schema.ts";
import { walk } from "../src/tree.ts";
import { A } from "./helpers.ts";

describe("strings", () => {
	it("reads a text object and a scalar string alike", () => {
		assert.equal(str("text"), "text");
		assert.equal(str(new A.ImmutableString("scalar")), "scalar");
		assert.equal(str(3), null);
	});

	it("reads a note whose fields are scalar strings", () => {
		const doc = A.from({
			"@patchwork": { type: new A.ImmutableString("file") },
			extension: new A.ImmutableString("md"),
			content: "body",
		});
		assert.equal(noteText(doc), "body");
	});
});

describe("folder entries", () => {
	const entry = (name: string, type: string, url: string) => ({ name, type, url });

	it("gives a colliding path to the entry whose url sorts lowest", () => {
		const { entries, skipped, collisions } = entriesOf({
			docs: [entry("Note.md", "md", "automerge:b"), entry("note.md", "md", "automerge:a")],
		});
		assert.deepEqual(entries, [entry("note.md", "md", "automerge:a")]);
		assert.deepEqual(collisions, [entry("Note.md", "md", "automerge:b")]);
		assert.deepEqual(skipped, []);
	});

	it("compares names in NFC", () => {
		const { entries } = entriesOf({
			docs: [entry("Café.md", "md", "automerge:b"), entry("Café.md", "md", "automerge:a")],
		});
		assert.equal(entries.length, 1);
	});

	it("leaves out names a file system or Obsidian cannot hold", () => {
		const { entries, skipped } = entriesOf({
			docs: [
				entry(".hidden.md", "md", "automerge:a"),
				entry("a/b.md", "md", "automerge:b"),
				entry("..", "folder", "automerge:c"),
				entry("plain", "md", "automerge:d"),
			],
		});
		assert.deepEqual(entries, []);
		assert.equal(skipped.length, 4);
	});

	it("ignores types it does not act on", () => {
		const { entries, skipped } = entriesOf({ docs: [entry("board.canvas", "canvas", "automerge:a")] });
		assert.deepEqual(entries, []);
		assert.deepEqual(skipped, []);
	});
});

describe("conflict names", () => {
	it("keep the extension of a note and the whole name of a folder", () => {
		assert.equal(conflictName("Plan.md", "md", "automerge:4NMNnkMhL8jXrdJ9"), "Plan (conflict 4NMNnk).md");
		assert.equal(conflictName("v1.2 notes", "folder", "automerge:4NMNnkMhL8jXrdJ9"), "v1.2 notes (conflict 4NMNnk)");
	});
});

describe("the tree walk", () => {
	const folder = (docs: object[]) => ({ "@patchwork": { type: "folder" }, docs });

	it("gives every note its path and survives a loop", async () => {
		const docs: Record<string, unknown> = {
			root: folder([
				{ name: "a", type: "folder", url: "sub" },
				{ name: "top.md", type: "md", url: "n1" },
			]),
			sub: folder([
				{ name: "deep.md", type: "md", url: "n2" },
				{ name: "back", type: "folder", url: "root" },
			]),
		};
		const tree = await walk(async (url) => docs[url] ?? null, "root");
		assert.deepEqual(Object.fromEntries(tree.notes), { "top.md": "n1", "a/deep.md": "n2" });
		assert.deepEqual(tree.skipped, ["a/back: a folder inside itself"]);
	});

	it("lists a note found at two paths once, and the other as a duplicate", async () => {
		const docs: Record<string, unknown> = {
			root: folder([
				{ name: "old", type: "folder", url: "f1" },
				{ name: "new", type: "folder", url: "f2" },
			]),
			f1: folder([{ name: "moving.md", type: "md", url: "n1" }]),
			f2: folder([{ name: "moving.md", type: "md", url: "n1" }]),
		};
		const tree = await walk(async (url) => docs[url] ?? null, "root");
		assert.deepEqual(Object.fromEntries(tree.notes), { "new/moving.md": "n1" });
		assert.deepEqual(tree.duplicates, [{ path: "old/moving.md", url: "n1" }]);
	});

	it("reports a folder the relay cannot supply", async () => {
		const tree = await walk(
			async (url) => (url === "root" ? folder([{ name: "gone", type: "folder", url: "x" }]) : null),
			"root",
		);
		assert.deepEqual(tree.skipped, ["gone: not available from the relay"]);
		assert.deepEqual(tree.unavailable, ["gone"]);
	});

	it("lists the entries that lost a collision, with their folder", async () => {
		const docs: Record<string, unknown> = {
			root: folder([{ name: "a", type: "folder", url: "f1" }]),
			f1: folder([
				{ name: "Same.md", type: "md", url: "n2" },
				{ name: "same.md", type: "md", url: "n1" },
			]),
		};
		const tree = await walk(async (url) => docs[url] ?? null, "root");
		assert.deepEqual(Object.fromEntries(tree.notes), { "a/same.md": "n1" });
		assert.deepEqual(tree.collisions, [{ folder: "a", name: "Same.md", type: "md", url: "n2" }]);
	});
});
