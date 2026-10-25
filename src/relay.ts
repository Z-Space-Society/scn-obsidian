// Plain HTTP calls to scn-sync-relay. The sync itself goes over the socket.

import type { Http } from "./auth.ts";

export interface Vault {
	rootDocId: string;
	// `automerge:<root_doc_id>`, the root folder document.
	url: string;
	name: string;
	createdAt: string;
	lastChangeAt: string | null;
}

// The relay refused the access token.
export class Unauthorized extends Error {}

// V1. `GET /vaults` answers `{"vaults": [...]}`, the member's own and no one
// else's: the relay takes the DID from the token.
export async function listVaults(http: Http, syncUrl: string, accessToken: string): Promise<Vault[]> {
	const response = await http({
		url: `${syncUrl}/vaults`,
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (response.status === 401) throw new Unauthorized("The relay refused this sign-in.");
	if (response.status !== 200) throw new Error(`The relay answered ${response.status} when listing vaults.`);
	const list = (response.json as { vaults?: unknown } | null)?.vaults;
	if (!Array.isArray(list)) throw new Error("The relay's vault list was not in the expected form.");
	return list.flatMap((item) => {
		const { root_doc_id, url, name, created_at, last_change_at } = item as Record<string, unknown>;
		if (typeof root_doc_id !== "string" || typeof url !== "string" || typeof name !== "string") return [];
		return [
			{
				rootDocId: root_doc_id,
				url,
				name,
				createdAt: typeof created_at === "string" ? created_at : "",
				lastChangeAt: typeof last_change_at === "string" ? last_change_at : null,
			},
		];
	});
}
