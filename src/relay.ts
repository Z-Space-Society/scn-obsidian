// Plain HTTP calls to scn-sync-relay. The sync itself goes over the socket.

import type { Http } from "./auth.ts";

export interface Vault {
	rootDocId: string;
	// `automerge:<root_doc_id>`, the root folder document.
	url: string;
	// Null for a member's private vault, which has no name of its own.
	name: string | null;
	// The workspace that holds it, or null for one of the member's own.
	workspace: string | null;
	// The relay's name for it under its group: "Private/Notes",
	// "Workspaces/SCN Development", or "Private" for the member's one private
	// vault. Where SCN Sync puts it (M2). Blank from a
	// relay older than v0.4.2, which this version does not mount.
	path: string;
	createdAt: string;
	lastChangeAt: string | null;
}

// The relay refused the access token.
export class Unauthorized extends Error {}

// V1. What `GET /vaults` answers.
export interface Listing {
	vaults: Vault[];
	// The folders vaults are grouped under, "Private" and "Workspaces", named
	// even when the member has no vault in one. Empty from a relay older than
	// v0.5.1, which does not send them.
	folders: string[];
}

// V1. `GET /vaults` answers `{"vaults": [...], "folders": [...]}`: the
// member's own vaults and their workspaces', and no one else's. The relay
// takes both from the token.
export async function listVaults(http: Http, syncUrl: string, accessToken: string): Promise<Listing> {
	const response = await http({
		url: `${syncUrl}/vaults`,
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (response.status === 401) throw new Unauthorized("The relay refused this sign-in.");
	if (response.status !== 200) throw new Error(`The relay answered ${response.status} when listing vaults.`);
	const json = response.json as { vaults?: unknown; folders?: unknown } | null;
	const list = json?.vaults;
	if (!Array.isArray(list)) throw new Error("The relay's vault list was not in the expected form.");
	const folders = Array.isArray(json?.folders) ? json.folders.filter((f): f is string => typeof f === "string" && f.trim() !== "") : [];
	const vaults = list.flatMap((item) => {
		const { root_doc_id, url, name, workspace, path, created_at, last_change_at } = item as Record<string, unknown>;
		if (typeof root_doc_id !== "string" || typeof url !== "string") return [];
		if (typeof name !== "string" && name !== null) return [];
		return [
			{
				rootDocId: root_doc_id,
				url,
				name,
				workspace: typeof workspace === "string" ? workspace : null,
				path: typeof path === "string" ? path : "",
				createdAt: typeof created_at === "string" ? created_at : "",
				lastChangeAt: typeof last_change_at === "string" ? last_change_at : null,
			},
		];
	});
	return { vaults, folders };
}
