import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entriesOf, noteText, str } from "../src/schema.ts";
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
		const { entries, skipped } = entriesOf({
			docs: [entry("Note.md", "md", "automerge:b"), entry("note.md", "md", "automerge:a")],
		});
		assert.deepEqual(entries, [entry("note.md", "md", "automerge:a")]);
		assert.deepEqual(skipped, [entry("Note.md", "md", "automerge:b")]);
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
		assert.deepEqual(tree.skipped, ["a/back: already at another path"]);
	});

	it("reports a folder the relay cannot supply", async () => {
		const tree = await walk(
			async (url) => (url === "root" ? folder([{ name: "gone", type: "folder", url: "x" }]) : null),
			"root",
		);
		assert.deepEqual(tree.skipped, ["gone: not available from the relay"]);
	});
});
