import { App, ButtonComponent, PluginSettingTab, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type ScnSync from "../main.ts";
import { SetupModal } from "./setup.ts";
import { statusRows } from "./status.ts";

// A row with a button. Obsidian searches the name and description given
// here; the render sets them on the row as well.
function buttonRow(name: string, desc: string, button: (b: ButtonComponent) => void): SettingDefinition {
	return { name, desc, render: (setting) => void setting.setName(name).setDesc(desc).addButton(button) };
}

// M11. Where new notes go, and the button that puts them in the private
// vault's folder.
function newNotesRow(plugin: ScnSync): SettingDefinition {
	const into = plugin.privateFolder();
	const syncing = plugin.newNotesSync();
	const { folder } = plugin.locations.newNotes();
	const desc = syncing ? `They go in ${folder}, so they sync.` : "They go outside your SCN vaults and stay on this device.";
	return buttonRow("New notes", desc, (b) => {
		b.setButtonText(into ? `Put in ${into}` : "Put in your private vault")
			.setDisabled(syncing || !into)
			// Saving redraws this tab.
			.onClick(() => void plugin.putNewNotesInPrivate());
	});
}

// Every step of setup is here too, so a dismissed modal loses nothing.
// Declarative, so the settings show in Obsidian's settings search.
export class ScnSyncSettingTab extends PluginSettingTab {
	plugin: ScnSync;

	constructor(app: App, plugin: ScnSync) {
		super(app, plugin);
		this.plugin = plugin;
		// A sign-in finishing in the background redraws the tab.
		plugin.onChange = () => this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { plugin } = this;
		const { settings } = plugin;
		const signedIn = plugin.signedIn();
		return [
			{
				type: "group",
				heading: "Account",
				items: [
					signedIn
						? buttonRow("Signed in", `${settings.did} at ${settings.syncUrl}`, (b) => {
								b.setButtonText("Sign out").onClick(() => plugin.signOut());
							})
						: buttonRow("Signed out", settings.syncUrl ? `Sync URL ${settings.syncUrl}` : "Not set up yet.", (b) => {
								b.setButtonText("Sign in")
									.setCta()
									.onClick(() => new SetupModal(this.app, plugin).open());
							}),
				],
			},
			{
				type: "group",
				heading: "Vaults",
				items: settings.connected
					? [
							buttonRow("Syncing with SCN", "Disconnecting keeps every file.", (b) => {
								b.setButtonText("Disconnect").onClick(() => void plugin.disconnect());
							}),
							newNotesRow(plugin),
							// M2. Each mounted vault and its folder, as the relay names it.
							...Object.values(settings.mounts)
								.sort((a, b) => a.path.localeCompare(b.path))
								.map((record) => ({ name: record.path, desc: `In ${record.folder}`, searchable: false })),
						]
					: [
							buttonRow("Not syncing", signedIn ? "Sync every SCN vault you can open." : "Sign in first.", (b) => {
								b.setButtonText("Connect")
									.setDisabled(!signedIn)
									.onClick(() => void plugin.connect());
							}),
						],
			},
			{
				type: "group",
				heading: "Status",
				visible: settings.connected,
				// Note paths and live counts, not settings to search for.
				items: statusRows(plugin).map(({ name, desc, button }) => ({
					...(button
						? buttonRow(name, desc, (b) => {
								b.setButtonText(button.text).onClick(button.onClick);
							})
						: { name, desc }),
					searchable: false,
				})),
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Issuer",
						desc: "Where to sign in, when the relay cannot say. Leave blank normally.",
						control: { type: "text", key: "issuerOverride", placeholder: "https://example.org" },
					},
				],
			},
		];
	}
}
