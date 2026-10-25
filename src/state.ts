// What the plugin keeps in `data.json`. Nothing secret: the refresh token is
// in SecretStorage and the access token only in memory (S4).

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
	// The relay vault this Obsidian vault is connected to, or blank.
	vaultUrl: string;
	vaultName: string;
}

export const DEFAULT_SETTINGS: Settings = {
	syncUrl: "",
	issuerOverride: "",
	issuer: "",
	tokenEndpoint: "",
	did: "",
	vaultUrl: "",
	vaultName: "",
};

// V4. A connected vault belongs to the member who connected it. Another
// member's pushes would be refused by the relay one document at a time.
export function signedInAsSomeoneElse(settings: Settings, did: string): boolean {
	return settings.vaultUrl !== "" && settings.did !== "" && settings.did !== did;
}
