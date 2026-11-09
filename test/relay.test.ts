import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Http } from "../src/auth.ts";
import { Gone, Unauthorized, listWorkspaces } from "../src/relay.ts";
import { signedInAsSomeoneElse, DEFAULT_SETTINGS } from "../src/state.ts";

const NOTES = "https://notes.scn.example";

describe("the workspace list", () => {
	it("reads the relay's /v1/workspaces answer with the bearer token", async () => {
		let seen: Record<string, string> | undefined;
		const http: Http = async (request) => {
			seen = request.headers;
			assert.equal(request.url, `${NOTES}/v1/workspaces`);
			return {
				status: 200,
				json: {
					workspaces: [
						{
							root_doc_id: "4NMN",
							url: "automerge:4NMN",
							name: null,
							group_id: null,
							path: "Private",
							created_at: "2026-10-15T21:27:41.881368Z",
							last_change_at: null,
							note_count: 3,
							bytes: 1024,
						},
						{
							root_doc_id: "7xQ2",
							url: "automerge:7xQ2",
							name: "SCN Development",
							group_id: "3",
							path: "Workspaces/SCN Development",
							created_at: "2026-11-04T18:00:00Z",
							last_change_at: "2026-11-04T18:05:00Z",
							note_count: null,
							bytes: null,
						},
					],
					root_folders: ["Private", "Workspaces"],
				},
			};
		};
		const { workspaces, rootFolders } = await listWorkspaces(http, NOTES, "token");
		assert.equal(seen?.Authorization, "Bearer token");
		assert.deepEqual(rootFolders, ["Private", "Workspaces"]);
		assert.deepEqual(workspaces, [
			{
				rootDocId: "4NMN",
				url: "automerge:4NMN",
				name: null,
				groupId: null,
				path: "Private",
				createdAt: "2026-10-15T21:27:41.881368Z",
				lastChangeAt: null,
			},
			{
				rootDocId: "7xQ2",
				url: "automerge:7xQ2",
				name: "SCN Development",
				groupId: "3",
				path: "Workspaces/SCN Development",
				createdAt: "2026-11-04T18:00:00Z",
				lastChangeAt: "2026-11-04T18:05:00Z",
			},
		]);
	});

	it("skips an entry with no path, which has nowhere to go", async () => {
		const http: Http = async () => ({
			status: 200,
			json: { workspaces: [{ root_doc_id: "a", url: "automerge:a", name: "Notes", group_id: null }], root_folders: [] },
		});
		const { workspaces } = await listWorkspaces(http, NOTES, "token");
		assert.deepEqual(workspaces, []);
	});

	it("keeps only the root folders that are names", async () => {
		const http: Http = async () => ({
			status: 200,
			json: { workspaces: [], root_folders: ["Private", "Workspaces", 3, ""] },
		});
		const { rootFolders } = await listWorkspaces(http, NOTES, "token");
		assert.deepEqual(rootFolders, ["Private", "Workspaces"]);
	});

	it("refuses the old shape", async () => {
		const http: Http = async () => ({ status: 200, json: { vaults: [], folders: [] } });
		await assert.rejects(listWorkspaces(http, NOTES, "token"));
	});

	it("is refused as unauthorized on 401", async () => {
		const http: Http = async () => ({ status: 401, json: null });
		await assert.rejects(listWorkspaces(http, NOTES, "token"), Unauthorized);
	});
});

describe("the version signals", () => {
	const empty = { workspaces: [], root_folders: ["Private", "Workspaces"] };

	it("reads the date a Sunset header names", async () => {
		const http: Http = async () => ({ status: 200, json: empty, headers: { sunset: "Thu, 10 Dec 2026 00:00:00 GMT" } });
		const { sunset } = await listWorkspaces(http, NOTES, "token");
		assert.equal(sunset?.toISOString(), "2026-12-10T00:00:00.000Z");
	});

	it("names no date without the header, or with one that does not parse", async () => {
		for (const headers of [undefined, {}, { sunset: "soon" }] as Array<Record<string, string> | undefined>) {
			const http: Http = async () => ({ status: 200, json: empty, headers });
			const { sunset } = await listWorkspaces(http, NOTES, "token");
			assert.equal(sunset, null);
		}
	});

	it("is Gone on 410, whatever the body", async () => {
		const http: Http = async () => ({ status: 410, json: empty, headers: { sunset: "Thu, 10 Dec 2026 00:00:00 GMT" } });
		await assert.rejects(listWorkspaces(http, NOTES, "token"), Gone);
	});

	it("is not Gone on any other refusal", async () => {
		for (const status of [404, 500, 503]) {
			const http: Http = async () => ({ status, json: null });
			await assert.rejects(listWorkspaces(http, NOTES, "token"), (e) => !(e instanceof Gone));
		}
	});
});

describe("one member per vault", () => {
	const connected = { ...DEFAULT_SETTINGS, did: "did:plc:alice", vaultUrl: "automerge:x", vaultName: "Notes" };

	it("refuses another member while a vault is connected", () => {
		assert.equal(signedInAsSomeoneElse(connected, "did:plc:bob"), true);
		assert.equal(signedInAsSomeoneElse(connected, "did:plc:alice"), false);
	});

	it("lets anyone sign in to a vault not yet connected", () => {
		assert.equal(signedInAsSomeoneElse({ ...connected, vaultUrl: "" }, "did:plc:bob"), false);
	});

	it("holds for a vault connected the 1.1 way, to every SCN vault", () => {
		const mounted = { ...DEFAULT_SETTINGS, did: "did:plc:alice", connected: true };
		assert.equal(signedInAsSomeoneElse(mounted, "did:plc:bob"), true);
		assert.equal(signedInAsSomeoneElse(mounted, "did:plc:alice"), false);
	});
});
