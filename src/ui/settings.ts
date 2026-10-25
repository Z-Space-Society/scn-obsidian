import { App, PluginSettingTab, Setting } from "obsidian";
import type ScnSync from "../main.ts";
import { SetupModal, VaultPickModal } from "./setup.ts";

// Every step of setup is here too, so a dismissed modal loses nothing.
export class ScnSyncSettingTab extends PluginSettingTab {
	plugin: ScnSync;

	constructor(app: App, plugin: ScnSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide() {
		this.plugin.onChange = null;
	}

	display() {
		const { containerEl, plugin } = this;
		const { settings } = plugin;
		containerEl.empty();
		plugin.onChange = () => this.display();

		new Setting(containerEl).setName("Account").setHeading();
		if (plugin.signedIn()) {
			new Setting(containerEl)
				.setName("Signed in")
				.setDesc(`${settings.did} at ${settings.syncUrl}`)
				.addButton((b) => b.setButtonText("Sign out").onClick(() => plugin.signOut()));
		} else {
			new Setting(containerEl)
				.setName("Signed out")
				.setDesc(settings.syncUrl ? `Sync URL ${settings.syncUrl}` : "Not set up yet.")
				.addButton((b) =>
					b
						.setButtonText("Sign in")
						.setCta()
						.onClick(() => new SetupModal(this.app, plugin).open()),
				);
		}

		new Setting(containerEl).setName("Vault").setHeading();
		if (settings.vaultUrl) {
			new Setting(containerEl)
				.setName(settings.vaultName)
				.setDesc("This Obsidian vault is connected to it. Disconnecting keeps every file.")
				.addButton((b) => b.setButtonText("Disconnect").onClick(() => void plugin.disconnect()));
		} else {
			new Setting(containerEl)
				.setName("No vault connected")
				.setDesc(plugin.signedIn() ? "Choose one of your SCN vaults." : "Sign in first.")
				.addButton((b) =>
					b
						.setButtonText("Choose vault")
						.setDisabled(!plugin.signedIn())
						.onClick(() => new VaultPickModal(this.app, plugin).open()),
				);
		}

		new Setting(containerEl).setName("Advanced").setHeading();
		new Setting(containerEl)
			.setName("Issuer")
			.setDesc("Where to sign in, when the relay cannot say. Leave blank normally.")
			.addText((t) =>
				t
					.setPlaceholder("https://example.org")
					.setValue(settings.issuerOverride)
					.onChange(async (v) => {
						settings.issuerOverride = v.trim();
						await plugin.saveData(settings);
					}),
			);
	}
}
