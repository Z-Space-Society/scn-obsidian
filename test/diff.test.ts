import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySplices, splicesBetween } from "../src/diff.ts";

const cases: Array<[string, string]> = [
	["", "new"],
	["gone", ""],
	["same", "same"],
	["# Hello\n\nFrom Claude.\n", "# Hello there\n\nFrom Claude, edited.\n"],
	["a\r\nb\r\n", "a\r\nB\r\nc\r\n"],
	["Option 2 🚀\n", "Option 2 🚀🚀 and more\n"],
	["🚀x", "🛸x"],
	["start 👩‍💻 end", "start 👩‍🔬 end"],
];

describe("splices", () => {
	for (const [from, to] of cases) {
		it(`turn ${JSON.stringify(from)} into ${JSON.stringify(to)}`, () => {
			assert.equal(applySplices(from, splicesBetween(from, to)), to);
		});
	}

	it("are empty for equal texts", () => {
		assert.deepEqual(splicesBetween("same", "same"), []);
	});

	it("come last first", () => {
		const splices = splicesBetween("one two three", "ONE two THREE");
		assert.ok(splices.length >= 2);
		assert.ok(splices[0].index > splices[splices.length - 1].index);
	});
});
