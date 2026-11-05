import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type ScnSync from "../main.ts";
import type { CrossMove } from "../mounts.ts";
import type { Plan } from "../sync/sync.ts";
import { describe } from "../messages.ts";

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
		plugin.setupModal = this;
		this.modalEl.addClass("scn-sync-setup");
		this.setTitle("Set up SCN Sync");
		contentEl.createEl("p", {
			text: "SCN Sync keeps the notes in this vault in step with any other devices or LLMs.",
		});
		contentEl.createEl("p", { text: "NOTE: your notes are not end-to-end encrypted." });

		contentEl.createEl("p", {
			text: "Your private vault is the Private folder, and each workspace you are in appears in a Workspaces folder. Notes outside those folders stay on this device.",
		});

		if (plugin.signedIn()) {
			const { connected } = plugin.settings;
			new Setting(contentEl)
				.setName("Signed in")
				.setDesc(connected ? "Syncing with SCN." : "Not syncing yet.")
				.addButton((b) =>
					b
						.setButtonText(connected ? "Done" : "Connect")
						.setCta()
						.onClick(() => {
							this.close();
							if (!connected) void plugin.connect();
						}),
				);
			return;
		}

		// Two taps: the first reaches the relay, the second opens the browser
		// straight from the tap, which iOS requires.
		let signInUrl: string | null = null;
		let button!: ButtonComponent;
		new Setting(contentEl)
			.setClass("scn-sync-url")
			.setName("Sync URL")
			.setDesc("Shown on the Notes page of your SCN site.")
			.addText((t) =>
				t
					.setPlaceholder("https://sync.example.org")
					.setValue(this.syncUrl)
					.onChange((v) => {
						this.syncUrl = v;
						signInUrl = null;
						button.setButtonText("Sign in");
						after.setText("");
					}),
			);
		const after = contentEl.createEl("p", { cls: "setting-item-description" });
		new Setting(contentEl).addButton((b) => {
			button = b
				.setButtonText("Sign in")
				.setCta()
				.onClick(async () => {
					if (signInUrl) {
						window.open(signInUrl);
						after.setText(
							"Sign in at SCN, then come back to Obsidian. If nothing comes back, check that you are an SCN member.",
						);
						return;
					}
					try {
						signInUrl = await plugin.prepareSignIn(this.syncUrl);
						button.setButtonText("Open SCN sign-in");
					} catch (e) {
						new Notice(`SCN Sync: ${describe(e)}`, 0);
					}
				});
		});
	}

	onClose() {
		if (this.plugin.setupModal === this) this.plugin.setupModal = null;
		this.contentEl.empty();
	}
}

// M4. A note moved from one vault's folder into another's cannot simply
// move: it becomes a new note there, and leaves the vault it was in.
export class MoveModal extends Modal {
	private move: CrossMove;
	private answer: (yes: boolean) => void = () => {};
	private answered = false;

	constructor(app: App, move: CrossMove) {
		super(app);
		this.move = move;
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
		const { contentEl, move } = this;
		const one = move.notes === 1;
		const what = one ? "This note" : `These ${move.notes} notes`;
		this.setTitle(`Move into ${move.toVault}?`);
		contentEl.createEl("p", {
			text: `${what} would leave ${move.fromVault} and become ${one ? "a new note" : "new notes"} in ${move.toVault}. Anyone who can open ${move.toVault} can read and change ${one ? "it" : "them"}.`,
		});
		contentEl.createEl("p", { text: "Cancel puts it back where it was." });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText("Move")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose() {
		this.contentEl.empty();
		this.finish(false);
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
					.setDestructive()
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
