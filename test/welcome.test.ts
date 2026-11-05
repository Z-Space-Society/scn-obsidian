import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldWrite, welcomeNote } from "../src/welcome.ts";

const STOCK =
	"This is your new *vault*.\n\nMake a note of something, [[create a link]], or try [the Importer](https://help.obsidian.md/Plugins/Importer)!\n\nWhen you're ready, delete this note and make the vault your own.\n";

describe("SCN's welcome note", () => {
	it("is written in place of Obsidian's, and never over the member's own", () => {
		assert.equal(shouldWrite(null, false), true);
		assert.equal(shouldWrite(STOCK, false), true);
		// A vault just made, whatever language Obsidian wrote it in.
		assert.equal(shouldWrite("Ceci est votre nouveau coffre.\n", true), true);
		assert.equal(shouldWrite("My own welcome, with plans.\n", false), false);
	});

	it("names the folders the relay names, whichever order they come in", () => {
		const note = welcomeNote("Zorp", ["Quux", "Zorp"]);
		assert.ok(note.includes("Zorp"));
		assert.ok(note.includes("Quux"));
		assert.ok(!welcomeNote("Zorp", ["Zorp"]).includes("Quux"));
	});
});
