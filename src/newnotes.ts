// M11. Where Obsidian puts new notes, and daily notes, so they land in a
// vault and sync. Obsidian keeps the first in its own config and the second
// in the Daily notes core plugin's settings; `NoteLocations` is the seam, so
// what is asked and what is set runs under `node --test`.

import type { App } from "obsidian";
import { within } from "./tree.ts";

export interface NoteLocations {
	// Obsidian's "Default location for new notes": "root", "current" (the
	// open note's folder) or "folder", with the folder for the last.
	newNotes(): { location: string; folder: string };
	setNewNotes(folder: string): void;
	// The Daily notes folder ("" is the root). Null when Daily notes is
	// off; undefined when it is on but its settings cannot be reached.
	dailyFolder(): string | null | undefined;
	setDailyFolder(folder: string): Promise<void>;
}

// Done once per device and kept in `data.json`: "yes" once it is done, "no"
// only from 1.2.2, which asked, and is kept.
export type NewNotesAnswer = "" | "yes" | "no";

function trimSlashes(folder: string): string {
	return folder.replace(/^\/+|\/+$/g, "");
}

function inVault(folder: string, vaultFolders: string[]): boolean {
	const trimmed = trimSlashes(folder);
	return trimmed !== "" && vaultFolders.some((vault) => within(trimmed, vault));
}

// Whether new notes already land in a vault's folder.
export function newNotesSync(locations: NoteLocations, vaultFolders: string[]): boolean {
	const { location, folder } = locations.newNotes();
	return location === "folder" && inVault(folder, vaultFolders);
}

// Once per device, as soon as the private vault is known.
export function shouldApply(answer: NewNotesAnswer, privateFolder: string | null): boolean {
	return answer === "" && privateFolder !== null;
}

// New notes go in `folder`, and so do daily notes when their folder is
// outside every vault and its setting can be reached. True when the Daily
// notes folder still needs setting by the member.
export async function putNewNotesIn(folder: string, locations: NoteLocations, vaultFolders: string[]): Promise<boolean> {
	locations.setNewNotes(folder);
	const daily = locations.dailyFolder();
	if (daily === null) return false;
	if (daily === undefined) return true;
	if (!inVault(daily, vaultFolders)) await locations.setDailyFolder(folder);
	return false;
}

interface VaultConfig {
	getConfig(key: string): unknown;
	setConfig(key: string, value: unknown): void;
}

interface DailyNotesInstance {
	options: { folder?: string };
	saveSettings(): Promise<void> | void;
}

// Obsidian's side. `getConfig` and `setConfig` are undocumented and long
// stable. The Daily notes plugin is read only when it has the shape looked
// for; anything else is left for the member to set.
export class ObsidianLocations implements NoteLocations {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	private get config(): VaultConfig {
		return this.app.vault as unknown as VaultConfig;
	}

	newNotes() {
		const location = this.config.getConfig("newFileLocation");
		const folder = this.config.getConfig("newFileFolderPath");
		return { location: typeof location === "string" ? location : "root", folder: typeof folder === "string" ? folder : "" };
	}

	setNewNotes(folder: string) {
		this.config.setConfig("newFileLocation", "folder");
		this.config.setConfig("newFileFolderPath", folder);
	}

	private daily(): { enabled: boolean; instance: DailyNotesInstance | null } | null {
		const internal = (this.app as unknown as { internalPlugins?: { getPluginById?: (id: string) => unknown } }).internalPlugins;
		const plugin = internal?.getPluginById?.("daily-notes") as { enabled?: unknown; instance?: Partial<DailyNotesInstance> } | undefined;
		if (!plugin) return null;
		const instance = plugin.instance;
		const reachable = typeof instance?.options === "object" && instance.options !== null && typeof instance.saveSettings === "function";
		return { enabled: plugin.enabled === true, instance: reachable ? (instance as DailyNotesInstance) : null };
	}

	dailyFolder() {
		const daily = this.daily();
		if (daily && !daily.enabled) return null;
		if (!daily?.instance) return undefined;
		return daily.instance.options.folder ?? "";
	}

	async setDailyFolder(folder: string) {
		const instance = this.daily()?.instance;
		if (!instance) return;
		instance.options.folder = folder;
		await instance.saveSettings();
	}
}
