import { App, Modal, Setting } from "obsidian";
import type ScnSync from "../main.ts";

// What syncs and what does not, for the settings tab and the status modal.
export function renderStatus(el: HTMLElement, plugin: ScnSync) {
	const { sync } = plugin;
	const last = plugin.lastSynced ? `Last up to date at ${new Date(plugin.lastSynced).toLocaleTimeString()}.` : "Not up to date yet since Obsidian started.";
	new Setting(el).setName(plugin.statusText()).setDesc(last);
	if (!sync) return;
	if (sync.guard.length > 0) {
		new Setting(el)
			.setName(`${sync.guard.length} notes missing here`)
			.setDesc("Nothing is sent about them until you answer whether to delete them on SCN or download them again.");
	}
	if (sync.vaultProblem()) {
		const page = plugin.notesPage();
		const row = new Setting(el)
			.setName("Several notes are not available from SCN")
			.setDesc("Their files stay here and can be edited. Check the vault on Corliss's Notes page.");
		if (page) row.addButton((b) => b.setButtonText("Open Notes page").onClick(() => window.open(page)));
	}
	for (const [path, reason] of sync.notSynced) {
		new Setting(el).setName(path).setDesc(reason);
	}
	for (const path of sync.unsent()) {
		new Setting(el).setName(path).setDesc("Only here so far. Waiting to upload.");
	}
	for (const line of sync.skipped) {
		new Setting(el).setName("Left out").setDesc(line);
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
		if (this.plugin.settings.vaultName) this.contentEl.createEl("p", { text: `Connected to ${this.plugin.settings.vaultName}.` });
		renderStatus(this.contentEl, this.plugin);
	}

	onClose() {
		this.contentEl.empty();
	}
}
