// Plain HTTP calls to SCN Notes. The sync itself goes over the socket.

import type { Http } from "./auth.ts";

export interface Workspace {
	rootDocId: string;
	// `automerge:<root_doc_id>`, the root folder document.
	url: string;
	// Null for a member's Private workspace, which has no name of its own.
	name: string | null;
	// The group that shares it, or null for the member's Private workspace.
	groupId: string | null;
	// The relay's name for it under its root folder: "Private" or
	// "Workspaces/SCN Development". Where SCN Sync puts it (M2).
	path: string;
	createdAt: string;
	lastChangeAt: string | null;
}

// The relay refused the access token.
export class Unauthorized extends Error {}

// 410 Gone: SCN Notes no longer serves the API this version of the plugin
// speaks. Only an update helps, so nothing retries.
export class Gone extends Error {}

// V1. What `GET /v1/workspaces` answers.
export interface Listing {
	workspaces: Workspace[];
	// The folders workspaces are grouped under, "Private" and "Workspaces",
	// named even when the member has no workspace in one.
	rootFolders: string[];
	// From a `Sunset` header (RFC 8594): when SCN Notes stops serving the API
	// this version speaks. Null while it is not retiring.
	sunset: Date | null;
}

// An HTTP date, or null for none or one that does not parse.
export function sunsetOf(headers: Record<string, string> | undefined): Date | null {
	const value = headers?.["sunset"];
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

// V1. `GET /v1/workspaces` answers `{"workspaces": [...], "root_folders":
// [...]}`: the member's Private workspace and their groups', and no one
// else's. The relay takes both from the token.
export async function listWorkspaces(http: Http, syncUrl: string, accessToken: string): Promise<Listing> {
	const response = await http({
		url: `${syncUrl}/v1/workspaces`,
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (response.status === 401) throw new Unauthorized("SCN Notes refused this sign-in.");
	if (response.status === 410) throw new Gone("This version of SCN Sync no longer works with SCN Notes; update it.");
	if (response.status !== 200) throw new Error(`SCN Notes answered ${response.status} when listing workspaces.`);
	const json = response.json as { workspaces?: unknown; root_folders?: unknown } | null;
	const list = json?.workspaces;
	if (!Array.isArray(list)) throw new Error("The workspace list from SCN Notes was not in the expected form.");
	const rootFolders = Array.isArray(json?.root_folders)
		? json.root_folders.filter((f): f is string => typeof f === "string" && f.trim() !== "")
		: [];
	const workspaces = list.flatMap((item) => {
		const { root_doc_id, url, name, group_id, path, created_at, last_change_at } = item as Record<string, unknown>;
		if (typeof root_doc_id !== "string" || typeof url !== "string") return [];
		if (typeof name !== "string" && name !== null) return [];
		// Every `/v1/` relay names a path. Without one there is nowhere to put it.
		if (typeof path !== "string" || path === "") return [];
		return [
			{
				rootDocId: root_doc_id,
				url,
				name,
				groupId: typeof group_id === "string" ? group_id : null,
				path,
				createdAt: typeof created_at === "string" ? created_at : "",
				lastChangeAt: typeof last_change_at === "string" ? last_change_at : null,
			},
		];
	});
	return { workspaces, rootFolders, sunset: sunsetOf(response.headers) };
}
