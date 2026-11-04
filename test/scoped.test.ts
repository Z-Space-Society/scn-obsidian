import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryFiles } from "../src/notes.ts";
import { ScopedFiles } from "../src/scoped.ts";

describe("a vault's folder", () => {
	function scoped() {
		const files = new MemoryFiles();
		files.files.set("Private/Notes/plan.md", "plan\n");
		files.files.set("Private/Notes/Ideas/a.md", "a\n");
		files.files.set("Private/Notes 2/other.md", "other\n");
		files.files.set("Scratch.md", "here only\n");
		return { files, notes: new ScopedFiles(files, "Private/Notes") };
	}

	it("lists only its own notes, relative to it", () => {
		assert.deepEqual(scoped().notes.list().sort(), ["Ideas/a.md", "plan.md"]);
	});

	it("reads, writes and moves inside it", async () => {
		const { files, notes } = scoped();
		assert.equal(await notes.read("plan.md"), "plan\n");
		await notes.write("new.md", "new\n");
		assert.equal(files.files.get("Private/Notes/new.md"), "new\n");
		assert.equal(await notes.rename("Ideas", "Later"), true);
		assert.equal(files.files.get("Private/Notes/Later/a.md"), "a\n");
		assert.equal(notes.hasFolder("Later"), true);
	});

	it("never removes the vault's own folder", async () => {
		const files = new MemoryFiles();
		files.folders.add("Private/Notes");
		await new ScopedFiles(files, "Private/Notes").removeFolderIfEmpty("");
		assert.equal(files.hasFolder("Private/Notes"), true);
	});
});
