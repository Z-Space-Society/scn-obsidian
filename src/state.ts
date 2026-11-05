// What the plugin keeps in `data.json`. Nothing secret: the refresh token is
// in SecretStorage and the access token only in memory (S4).

import type { MountRecord } from "./mounts.ts";
import type { NewNotesAnswer } from "./newnotes.ts";

export interface Settings {
	// `https://<sync host>`, the one value the member pastes.
	syncUrl: string;
	// Set by hand under Advanced when discovery fails. Blank otherwise.
	issuerOverride: string;
	// Corliss, as the last sign-in found it.
	issuer: string;
	tokenEndpoint: string;
	// The member this vault signed in as. Kept through sign-out, so V4 can
	// refuse a different member while a vault is connected.
	did: string;
	// M1. Whether this Obsidian vault syncs with SCN: every vault the member
	// can open, each in its own folder.
	connected: boolean;
	// M2. Each mounted vault by root document ID: where it is, and its store.
	mounts: Record<string, MountRecord>;
	// M8. The one relay vault SCN Sync 1.0 connected this Obsidian vault to,
	// with its notes at the root. Read once, to migrate, then cleared.
	vaultUrl: string;
	vaultName: string;
	// Names this vault's IndexedDB databases. IndexedDB is shared by every
	// vault Obsidian opens, so the vault's name alone would not do.
	storeId: string;
	// M5. The folders the relay groups vaults under, as it last named them.
	folders: string[];
	// M12. Null until decided on this device; then the path of SCN's
	// Welcome.md, which stays here and is never offered a move, or "" when
	// none was written.
	welcome: string | null;
	// M11. The answer to "put new notes in the private vault?", asked once.
	newNotesAnswer: NewNotesAnswer;
}

export const DEFAULT_SETTINGS: Settings = {
	syncUrl: "",
	issuerOverride: "",
	issuer: "",
	tokenEndpoint: "",
	did: "",
	connected: false,
	mounts: {},
	vaultUrl: "",
	vaultName: "",
	storeId: "",
	folders: [],
	welcome: null,
	newNotesAnswer: "",
};

// V4. A connected vault belongs to the member who connected it. Another
// member's pushes would be refused by the relay one document at a time.
export function signedInAsSomeoneElse(settings: Settings, did: string): boolean {
	return (settings.connected || settings.vaultUrl !== "") && settings.did !== "" && settings.did !== did;
}
