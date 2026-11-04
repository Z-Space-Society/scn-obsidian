import { App, Modal, Setting } from "obsidian";
import type ScnSync from "../main.ts";

export interface StatusRow {
	name: string;
	desc: string;
	button?: { text: string; onClick: () => void };
}

// What syncs and what does not, for the settings tab and the status modal.
export function statusRows(plugin: ScnSync): StatusRow[] {
	const { mounts } = plugin;
	const last = plugin.lastSynced ? `Last up to date at ${new Date(plugin.lastSynced).toLocaleTimeString()}.` : "Not up to date yet since Obsidian started.";
	const rows: StatusRow[] = [{ name: plugin.statusText(), desc: last }];
	if (!mounts) return rows;
	const guarding = mounts.guarding();
	if (guarding > 0) {
		rows.push({
			name: `${guarding} notes missing here`,
			desc: "Nothing is sent about them until you answer whether to delete them on SCN or download them again.",
		});
	}
	if (mounts.vaultProblem()) {
		const page = plugin.notesPage();
		rows.push({
			name: "Several notes are not available from SCN",
			desc: "Their files stay here and can be edited. Check the vault on Corliss's Notes page.",
			button: page ? { text: "Open Notes page", onClick: () => window.open(page) } : undefined,
		});
	}
	for (const [path, reason] of mounts.notSynced()) rows.push({ name: path, desc: reason });
	for (const path of mounts.unsent()) rows.push({ name: path, desc: "Only here so far. Waiting to upload." });
	for (const line of mounts.skipped()) rows.push({ name: "Left out", desc: line });
	return rows;
}

function renderStatus(el: HTMLElement, plugin: ScnSync) {
	for (const { name, desc, button } of statusRows(plugin)) {
		const row = new Setting(el).setName(name).setDesc(desc);
		if (button) row.addButton((b) => b.setButtonText(button.text).onClick(button.onClick));
	}
}

export class StatusModal extends Modal {
	private plugin: ScnSync;

	constructor(app: App, plugin: ScnSync) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.setTitle("SCN Sync");
		const paths = Object.values(this.plugin.settings.mounts).map((record) => record.path).sort();
		if (paths.length) this.contentEl.createEl("p", { text: `Syncing ${paths.join(", ")}.` });
		renderStatus(this.contentEl, this.plugin);
	}

	onClose() {
		this.contentEl.empty();
	}
}
