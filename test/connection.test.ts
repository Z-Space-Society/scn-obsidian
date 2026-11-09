import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { socketUrl } from "../src/connection.ts";

describe("the socket address", () => {
	it("is /v1/sync on the notes host, with the token in the query", () => {
		const url = new URL(socketUrl("https://notes.scn.example:8443", "a.b+c/d"));
		assert.equal(url.protocol, "wss:");
		assert.equal(url.host, "notes.scn.example:8443");
		assert.equal(url.pathname, "/v1/sync");
		assert.equal(url.searchParams.get("access_token"), "a.b+c/d");
	});
});
