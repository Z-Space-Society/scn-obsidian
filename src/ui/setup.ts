import { App, FileSystemAdapter, Modal, Notice, Platform, Setting } from "obsidian";
import type ScnSync from "../main.ts";
import type { Plan } from "../sync/sync.ts";
import { describe } from "../messages.ts";

// Says what is wrong with where this vault lives, or null. On iOS the path is
// relative and tells nothing, so the instruction is given instead.
export function iCloudWarning(app: App): string | null {
	if (Platform.isIosApp) {
		return "Keep this vault out of iCloud. Two sync tools on one folder fight over the files.";
	}
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter && /Mobile Documents|iCloud/i.test(adapter.getBasePath())) {
		return "This vault is in iCloud Drive. Two sync tools on one folder fight over the files. Move the vault out of iCloud Drive before signing in.";
	}
	return null;
}

export class SetupModal extends Modal {
	plugin: ScnSync;
	syncUrl: string;

	constructor(app: App, plugin: ScnSync) {
		super(app);
		this.plugin = plugin;
		this.syncUrl = plugin.settings.syncUrl;
	}

	onOpen() {
		const { contentEl, plugin } = this;
		contentEl.empty();
		this.setTitle("Set up SCN Sync");
		contentEl.createEl("p", {
			text: "SCN Sync keeps the notes in this Obsidian vault in step with one of your vaults on the Shared Computer Network. Edits made here, on your other devices and by Claude reach each other.",
		});
		contentEl.createEl("p", { text: "Your notes are not end-to-end encrypted. SCN's operators can read them." });

		const warning = iCloudWarning(this.app);
		if (warning) contentEl.createEl("p", { text: warning, cls: "mod-warning" });

		const notes = this.app.vault.getMarkdownFiles().length;
		if (notes > 0 && !plugin.settings.vaultUrl) {
			contentEl.createEl("p", {
				cls: "mod-warning",
				text: `This vault already holds ${notes} ${notes === 1 ? "note" : "notes"}. SCN Sync is meant for a new, empty vault. If you continue, nothing here is overwritten: a note that differs from the one in your SCN vault is kept as a copy.`,
			});
		}

		if (plugin.signedIn()) {
			new Setting(contentEl)
				.setName("Signed in")
				.setDesc(plugin.settings.vaultUrl ? `Connected to ${plugin.settings.vaultName}.` : "No vault chosen yet.")
				.addButton((b) =>
					b
						.setButtonText(plugin.settings.vaultUrl ? "Done" : "Choose vault")
						.setCta()
						.onClick(() => {
							this.close();
							if (!plugin.settings.vaultUrl) new VaultPickModal(this.app, plugin).open();
						}),
				);
			return;
		}

		new Setting(contentEl)
			.setName("Sync URL")
			.setDesc("Shown on the Notes page of your SCN site.")
			.addText((t) =>
				t
					.setPlaceholder("https://sync.example.org")
					.setValue(this.syncUrl)
					.onChange((v) => (this.syncUrl = v)),
			);
		const after = contentEl.createEl("p", { cls: "setting-item-description" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Sign in")
				.setCta()
				.onClick(async () => {
					try {
						await plugin.startSignIn(this.syncUrl);
						after.setText(
							"Your browser opens at SCN. Sign in, then come back to Obsidian. If nothing comes back, check that you are an SCN member.",
						);
					} catch (e) {
						new Notice(`SCN Sync: ${describe(e)}`, 0);
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class VaultPickModal extends Modal {
	plugin: ScnSync;

	constructor(app: App, plugin: ScnSync) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl, plugin } = this;
		this.setTitle("Choose a vault");
		const status = contentEl.createEl("p", { text: "Asking the relay for your vaults…" });
		let vaults;
		try {
			vaults = await plugin.vaults();
		} catch (e) {
			status.setText(describe(e));
			return;
		}
		status.remove();

		if (vaults.length === 0) {
			const p = contentEl.createEl("p", { text: "You have no vaults yet. Create one on the " });
			const page = plugin.notesPage();
			if (page) p.createEl("a", { text: "Notes page", href: page });
			else p.appendText("Notes page");
			p.appendText(", then choose it here.");
			return;
		}

		contentEl.createEl("p", { text: "This Obsidian vault connects to one of them." });
		for (const vault of vaults) {
			const changed = vault.lastChangeAt ? new Date(vault.lastChangeAt).toLocaleString() : "never";
			new Setting(contentEl)
				.setName(vault.name)
				.setDesc(`Last change: ${changed}`)
				.addButton((b) =>
					b
						.setButtonText("Connect")
						.setCta()
						.onClick(async () => {
							await plugin.connect(vault);
							this.close();
						}),
				);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

// V3. The member is told what connecting will do before it is done.
export class ConnectModal extends Modal {
	private plan: Plan;
	private vaultName: string;
	private answer: (yes: boolean) => void = () => {};
	private answered = false;

	constructor(app: App, plan: Plan, vaultName: string) {
		super(app);
		this.plan = plan;
		this.vaultName = vaultName;
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.answer = resolve;
			this.open();
		});
	}

	private finish(yes: boolean) {
		if (this.answered) return;
		this.answered = true;
		this.answer(yes);
		this.close();
	}

	onOpen() {
		const { contentEl, plan } = this;
		this.setTitle(`Connect to ${this.vaultName}`);
		const list = contentEl.createEl("ul");
		if (plan.download.length) {
			list.createEl("li", { text: `${count(plan.download.length, "note is", "notes are")} downloaded from SCN.` });
		}
		if (plan.adopt.length) {
			list.createEl("li", { text: `${count(plan.adopt.length, "note here already matches", "notes here already match")} and ${plan.adopt.length === 1 ? "is" : "are"} left as ${plan.adopt.length === 1 ? "it is" : "they are"}.` });
		}
		if (plan.copy.length) {
			list.createEl("li", {
				text: `${count(plan.copy.length, "note here differs", "notes here differ")} from SCN. Yours ${plan.copy.length === 1 ? "is" : "are"} kept as a "local copy" beside the original, and SCN's version takes the original name.`,
			});
		}
		if (plan.localOnly.length) {
			list.createEl("li", {
				text: `${count(plan.localOnly.length, "note here is", "notes here are")} not on SCN and ${plan.localOnly.length === 1 ? "is" : "are"} uploaded.`,
			});
		}
		if (list.childElementCount === 0) list.createEl("li", { text: "This vault is empty on SCN and here." });
		contentEl.createEl("p", { text: "Nothing here is deleted or overwritten without a copy." });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText("Connect")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose() {
		this.contentEl.empty();
		this.finish(false);
	}
}

// O6. Most of the vault's notes are missing at startup. A vault folder that
// moved or is not mounted must not empty SCN, so nothing is sent until the
// member says. Closing the modal downloads them again, which loses nothing.
export class DeleteGuardModal extends Modal {
	private paths: string[];
	private vaultName: string;
	private answer: (remove: boolean) => void = () => {};
	private answered = false;

	constructor(app: App, paths: string[], vaultName: string) {
		super(app);
		this.paths = paths;
		this.vaultName = vaultName;
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.answer = resolve;
			this.open();
		});
	}

	private finish(remove: boolean) {
		if (this.answered) return;
		this.answered = true;
		this.answer(remove);
		this.close();
	}

	onOpen() {
		const { contentEl, paths } = this;
		this.setTitle(`${count(paths.length, "note is", "notes are")} missing here`);
		contentEl.createEl("p", {
			text: `They were in step with ${this.vaultName} on SCN when SCN Sync last ran, and nothing has been sent about them yet.`,
		});
		contentEl.createEl("p", {
			text: "If this vault's folder moved, or is not all there yet, download them again. If you deleted them, delete them on SCN too.",
		});
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Delete on SCN")
					.setWarning()
					.onClick(() => this.finish(true)),
			)
			.addButton((b) =>
				b
					.setButtonText("Download again")
					.setCta()
					.onClick(() => this.finish(false)),
			);
	}

	onClose() {
		this.contentEl.empty();
		this.finish(false);
	}
}
