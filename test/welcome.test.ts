import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { welcomeNote } from "../src/welcome.ts";

describe("SCN Sync's welcome note", () => {
	it("names the folders the relay names, whichever order they come in", () => {
		const note = welcomeNote("Zorp", ["Quux", "Zorp"]);
		assert.ok(note.includes("Zorp"));
		assert.ok(note.includes("Quux"));
		assert.ok(!welcomeNote("Zorp", ["Zorp"]).includes("Quux"));
	});
});
