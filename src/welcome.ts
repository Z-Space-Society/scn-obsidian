// M12. SCN's own Welcome.md, in place of the one Obsidian puts in a new
// vault. It stays at the root of this device's vault and never syncs: it is
// help for this Obsidian, not a note. The folder names come from the relay,
// so the words are spelled here no more than anywhere else in the plugin.

export const WELCOME = "Welcome.md";

// What Obsidian's own Welcome.md says, in the versions seen so far.
const STOCK = "This is your new *vault*.";

// Written when there is no Welcome.md, or when the one there is Obsidian's:
// its words, or the only note outside every vault in a vault just made. One
// the member has written in is left alone.
export function shouldWrite(existing: string | null, onlyNote: boolean): boolean {
	return existing === null || onlyNote || existing.includes(STOCK);
}

// `privateFolder` is the private vault's; `folders` the relay's, of which the
// other is the workspaces'. Neither is picked by its place in the list.
export function welcomeNote(privateFolder: string, folders: string[]): string {
	const priv = privateFolder;
	const workspaces = folders.find((folder) => folder !== priv);
	const lines = [
		"# Welcome to SCN Sync",
		"",
		"This note is from SCN Sync. It stays on this device and does not sync, so delete it whenever you like.",
		"",
		"## What syncs",
		"",
		"SCN Sync keeps your notes in step with SCN, the Shared Computer Network: the same on every device you sign in on, and open to the AI tools you connect to your notes.",
		"",
		`- **${priv}** is your private vault. Only you can open it, from your own devices and the AI tools you connect.`,
	];
	if (workspaces) {
		lines.push(
			`- **${workspaces}** holds a folder for each workspace you are in. Everyone in a workspace can read and change its notes. When you are added to a workspace, its folder appears here.`,
		);
	}
	lines.push(
		"",
		`Everything else in this vault stays on this device. New notes go in ${priv}. When a note or folder lands outside the folders above, SCN Sync says so and offers to move it into ${priv}.`,
		"",
		"NOTE: Notes are not encrypted at rest.",
		"",
		"## How things stand",
		"",
		"The SCN Sync item in the status bar says where things are:",
		"",
		"- **Up to date**: everything here is on SCN.",
		"- **Syncing**: changes are on their way.",
		"- **Offline**: changes wait here and go once you are back online.",
		"- **Attention**: something needs a look, such as a note outside the synced folders.",
		"- **Signed out**: sign in again under Settings, SCN Sync.",
		"",
		"The SCN Sync icon in the left ribbon shows the details, and what to do about anything needing attention. Settings, SCN Sync lists each vault and its folder, and where new notes go.",
		"",
		"## Commands",
		"",
		"Press Ctrl-P (Cmd-P on a Mac) to open the command palette. On a phone, pull down on a note to open it.",
		"",
		"- **Reload app without saving**: restarts Obsidian and SCN Sync with it. Use it if sync seems stuck or a workspace you were added to hasn't shown up.",
		"- **SCN Sync: Reconnect now**: a lighter fix that only reconnects to SCN.",
		"- **SCN Sync: Open sync status**: the same as the ribbon icon.",
		"",
	);
	return lines.join("\n");
}
