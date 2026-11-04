import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Http } from "../src/auth.ts";
import { Unauthorized, listVaults } from "../src/relay.ts";
import { signedInAsSomeoneElse, DEFAULT_SETTINGS } from "../src/state.ts";

const SYNC = "https://sync.scn.example";

describe("the vault list", () => {
	it("reads the relay's {vaults: [...]} answer with the bearer token", async () => {
		let seen: Record<string, string> | undefined;
		const http: Http = async (request) => {
			seen = request.headers;
			assert.equal(request.url, `${SYNC}/vaults`);
			return {
				status: 200,
				json: {
					vaults: [
						{
							root_doc_id: "4NMNnkMhL8jXrdJ9jamS58PAVdXu",
							url: "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu",
							name: "SCN Notes",
							workspace: null,
							path: "Private/SCN Notes",
							created_at: "2026-10-15T21:27:41.881368Z",
							last_change_at: null,
						},
						{
							root_doc_id: "7xQ2",
							url: "automerge:7xQ2",
							name: "SCN Development",
							workspace: "3",
							path: "Workspaces/SCN Development",
							created_at: "2026-11-04T18:00:00Z",
							last_change_at: "2026-11-04T18:05:00Z",
						},
					],
				},
			};
		};
		const vaults = await listVaults(http, SYNC, "token");
		assert.equal(seen?.Authorization, "Bearer token");
		assert.deepEqual(vaults, [
			{
				rootDocId: "4NMNnkMhL8jXrdJ9jamS58PAVdXu",
				url: "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu",
				name: "SCN Notes",
				workspace: null,
				path: "Private/SCN Notes",
				createdAt: "2026-10-15T21:27:41.881368Z",
				lastChangeAt: null,
			},
			{
				rootDocId: "7xQ2",
				url: "automerge:7xQ2",
				name: "SCN Development",
				workspace: "3",
				path: "Workspaces/SCN Development",
				createdAt: "2026-11-04T18:00:00Z",
				lastChangeAt: "2026-11-04T18:05:00Z",
			},
		]);
	});

	it("reads a relay older than v0.4.2 as naming no path", async () => {
		const http: Http = async () => ({
			status: 200,
			json: { vaults: [{ root_doc_id: "a", url: "automerge:a", name: "Notes" }] },
		});
		const [vault] = await listVaults(http, SYNC, "token");
		assert.equal(vault.path, "");
		assert.equal(vault.workspace, null);
	});

	it("reads a private vault with no name, at the path Private", async () => {
		const http: Http = async () => ({
			status: 200,
			json: { vaults: [{ root_doc_id: "a", url: "automerge:a", name: null, workspace: null, path: "Private" }] },
		});
		const [vault] = await listVaults(http, SYNC, "token");
		assert.equal(vault.name, null);
		assert.equal(vault.path, "Private");
	});

	it("is refused as unauthorized on 401", async () => {
		const http: Http = async () => ({ status: 401, json: null });
		await assert.rejects(listVaults(http, SYNC, "token"), Unauthorized);
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
