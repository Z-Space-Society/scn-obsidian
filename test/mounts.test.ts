import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Repo, type DocHandle } from "@automerge/automerge-repo/slim";
import { MemoryFiles, MemoryNoteStore } from "../src/notes.ts";
import {
	Mounts,
	assignFolders,
	folderOf,
	legacyRecord,
	needsAsking,
	safeSegment,
	type CrossMove,
	type MountRecord,
	type MountVault,
} from "../src/mounts.ts";
import { newNotesSync, putNewNotesIn, shouldAsk } from "../src/newnotes.ts";
import { noteText } from "../src/schema.ts";
import { walk } from "../src/tree.ts";
import { MemoryLocations, eventually, folder, note, pipes, relayRepo } from "./helpers.ts";
import { TODAY } from "./setup.ts";

const running: Mounts[] = [];
afterEach(async () => {
	for (const mounts of running.splice(0)) await mounts.stop();
});

// One relay holding a private vault and a workspace's vault.
function relayWithTwoVaults() {
	const [pluginEnd, relayEnd] = pipes();
	const relay = relayRepo(relayEnd);
	const plan = note(relay, "plan.md", "# Plan\n");
	const welcome = note(relay, "Welcome.md", "Hi Scott and Boris.\n");
	const notes = folder(relay, "Notes", [["plan.md", plan]]);
	const garden = folder(relay, "SCN Development", [["Welcome.md", welcome]]);
	const vaults: MountVault[] = [
		{ rootDocId: notes.documentId, url: notes.url, path: "Private/Notes", private: true },
		{ rootDocId: garden.documentId, url: garden.url, path: "Workspaces/SCN Development" },
	];
	return { relay, pluginEnd, notes, garden, vaults };
}

function plugin(
	setup: ReturnType<typeof relayWithTwoVaults>,
	options: {
		files?: MemoryFiles;
		records?: Record<string, MountRecord>;
		stores?: Map<string, MemoryNoteStore>;
		confirmMove?: (move: CrossMove) => Promise<boolean>;
	} = {},
) {
	const repo = new Repo({ network: [setup.pluginEnd] });
	const files = options.files ?? new MemoryFiles();
	const stores = options.stores ?? new Map<string, MemoryNoteStore>();
	const notices: string[] = [];
	const asked: string[] = [];
	const moves: CrossMove[] = [];
	const offers: Array<{ paths: string[]; into: string | null }> = [];
	let saved: Record<string, MountRecord> = {};
	const mounts = new Mounts(
		{
			repo,
			files,
			openStore: (name) => {
				if (!stores.has(name)) stores.set(name, new MemoryNoteStore());
				return stores.get(name)!;
			},
			deleteStore: async (name) => void stores.delete(name),
			newStoreName: (id) => `notes-${id}`,
			saveRecords: async (records) => void (saved = records),
			confirm: async (_plan, path) => (asked.push(path), true),
			confirmDeletes: async () => false,
			confirmMove: async (move) => (moves.push(move), options.confirmMove ? options.confirmMove(move) : true),
			offerMove: (paths, into) => void offers.push({ paths, into }),
			notify: (text) => void notices.push(text),
			online: () => true,
			onStatus: () => {},
			today: () => TODAY,
		},
		options.records ?? {},
	);
	running.push(mounts);
	return { mounts, files, stores, notices, asked, moves, offers, repo, saved: () => saved };
}

// What the relay's vault holds, path to text.
async function onRelay(relay: Repo, root: DocHandle<unknown>) {
	const open = async (url: string) => {
		const handle = await relay.find<unknown>(url as never, { allowableStates: ["ready", "unavailable"] });
		return handle.isReady() ? handle.doc() : null;
	};
	const tree = await walk(open, root.url);
	const notes: Record<string, string | null> = {};
	for (const [path, url] of tree.notes) notes[path] = noteText(await open(url));
	return notes;
}

async function mounted() {
	const setup = relayWithTwoVaults();
	const local = plugin(setup);
	await local.mounts.update(setup.vaults);
	await eventually(
		() => local.files.files.has("Private/Notes/plan.md") && local.files.files.has("Workspaces/SCN Development/Welcome.md"),
		"both vaults to download",
	);
	await local.mounts.idle();
	return { ...setup, ...local };
}

describe("folders", () => {
	it("are the relay's path, each segment made safe", () => {
		assert.equal(folderOf("Workspaces/SCN Development"), "Workspaces/SCN Development");
		assert.equal(folderOf("Private/a/b: c?"), "Private/a-b- c-");
		assert.equal(folderOf("Private/.hidden"), "Private/hidden");
		assert.equal(folderOf("Private"), "Private");
		assert.equal(folderOf("/Notes"), null);
		assert.equal(folderOf(""), null);
		assert.equal(safeSegment("   "), "Untitled");
	});

	it("collide into numbered folders, and keep the one they have", () => {
		const a = { rootDocId: "a", url: "automerge:a", path: "Workspaces/Garden" };
		const b = { rootDocId: "b", url: "automerge:b", path: "Workspaces/garden" };
		assert.deepEqual([...assignFolders([a, b], {}).values()], ["Workspaces/Garden", "Workspaces/garden (2)"]);
		const kept = { b: { url: "", path: "", folder: "Workspaces/garden", store: "" } };
		assert.deepEqual(Object.fromEntries(assignFolders([a, b], kept)), { b: "Workspaces/garden", a: "Workspaces/Garden (2)" });
	});

	it("never ask to connect when there is nothing to copy or upload", () => {
		assert.equal(needsAsking({ download: ["a.md"], adopt: ["b.md"], copy: [], localOnly: [] }), false);
		assert.equal(needsAsking({ download: [], adopt: [], copy: ["a.md"], localOnly: [] }), true);
		assert.equal(needsAsking({ download: [], adopt: [], copy: [], localOnly: ["a.md"] }), true);
	});
});

describe("mounting", () => {
	it("downloads every vault into its own folder without asking", async () => {
		const { files, asked, saved, notes, garden } = await mounted();
		assert.deepEqual(Object.fromEntries(files.files), {
			"Private/Notes/plan.md": "# Plan\n",
			"Workspaces/SCN Development/Welcome.md": "Hi Scott and Boris.\n",
		});
		assert.deepEqual(asked, []);
		assert.equal(saved()[notes.documentId].folder, "Private/Notes");
		assert.equal(saved()[garden.documentId].folder, "Workspaces/SCN Development");
	});

	it("sends an edit in a workspace folder to that vault only", async () => {
		const { mounts, files, relay, garden, notes } = await mounted();
		files.files.set("Workspaces/SCN Development/Welcome.md", "Hi Scott and Boris.\nWelcome!\n");
		mounts.fileChanged("Workspaces/SCN Development/Welcome.md");
		await eventually(async () => (await onRelay(relay, garden))["Welcome.md"] === "Hi Scott and Boris.\nWelcome!\n", "the edit to reach the workspace vault");
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });
	});

	it("leaves a file outside every vault alone", async () => {
		const { mounts, files, relay, notes, garden } = await mounted();
		files.files.set("Scratch.md", "only here\n");
		mounts.created("Scratch.md");
		await mounts.idle();
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });
		assert.deepEqual(await onRelay(relay, garden), { "Welcome.md": "Hi Scott and Boris.\n" });
	});

	it("mounts again from its records, offline, at the next start", async () => {
		const first = await mounted();
		const records = first.saved();
		await first.mounts.stop();
		const again = plugin(first, { files: first.files, records, stores: first.stores });
		await again.mounts.start();
		assert.deepEqual([...again.mounts.mounts.values()].map((m) => m.record.folder).sort(), ["Private/Notes", "Workspaces/SCN Development"]);
	});

	it("applies nothing from a relay that names no paths", async () => {
		const setup = relayWithTwoVaults();
		const local = plugin(setup);
		await local.mounts.update(setup.vaults.map((v) => ({ ...v, path: "" })));
		assert.equal(local.mounts.mounts.size, 0);
		assert.match(local.notices[0], /needs updating/);
	});
});

describe("joining and leaving", () => {
	it("stops syncing a vault that leaves the list, and keeps its files", async () => {
		const { mounts, files, stores, notices, vaults, saved, garden } = await mounted();
		const storeName = saved()[garden.documentId].store;
		await mounts.update([vaults[0]]);
		assert.equal(mounts.mounts.has(garden.documentId), false);
		assert.equal(files.files.get("Workspaces/SCN Development/Welcome.md"), "Hi Scott and Boris.\n");
		assert.equal(stores.has(storeName), false);
		assert.match(notices[notices.length - 1], /Workspaces\/SCN Development no longer syncs/);
	});

	it("moves a renamed workspace's folder and keeps syncing it", async () => {
		const { mounts, files, relay, garden, vaults } = await mounted();
		await mounts.update([vaults[0], { ...vaults[1], path: "Workspaces/Seed Library" }]);
		assert.equal(files.files.get("Workspaces/Seed Library/Welcome.md"), "Hi Scott and Boris.\n");
		assert.equal(files.files.has("Workspaces/SCN Development/Welcome.md"), false);
		// The rename's own event is not a move by the member.
		mounts.renamed("Workspaces/SCN Development", "Workspaces/Seed Library", true);
		await mounts.idle();
		files.files.set("Workspaces/Seed Library/Welcome.md", "Renamed and still here.\n");
		mounts.fileChanged("Workspaces/Seed Library/Welcome.md");
		await eventually(async () => (await onRelay(relay, garden))["Welcome.md"] === "Renamed and still here.\n", "an edit after the rename");
	});
});

describe("moving across vaults", () => {
	it("shares a private note with a workspace when the member says yes", async () => {
		const { mounts, files, relay, notes, garden, moves } = await mounted();
		await files.rename("Private/Notes/plan.md", "Workspaces/SCN Development/plan.md");
		mounts.renamed("Private/Notes/plan.md", "Workspaces/SCN Development/plan.md", false);
		await eventually(async () => (await onRelay(relay, garden))["plan.md"] === "# Plan\n", "the note to reach the workspace");
		await eventually(async () => !("plan.md" in (await onRelay(relay, notes))), "the note to leave the private vault");
		assert.deepEqual(moves.map((m) => [m.fromVault, m.toVault, m.notes]), [["Private/Notes", "Workspaces/SCN Development", 1]]);
	});

	it("puts the note back when the member says no", async () => {
		const setup = relayWithTwoVaults();
		const local = plugin(setup, { confirmMove: async () => false });
		await local.mounts.update(setup.vaults);
		await eventually(() => local.files.files.has("Private/Notes/plan.md"), "the download");
		await local.mounts.idle();
		await local.files.rename("Private/Notes/plan.md", "Workspaces/SCN Development/plan.md");
		local.mounts.renamed("Private/Notes/plan.md", "Workspaces/SCN Development/plan.md", false);
		await local.mounts.idle();
		assert.equal(local.files.files.get("Private/Notes/plan.md"), "# Plan\n");
		assert.equal(local.files.files.has("Workspaces/SCN Development/plan.md"), false);
		assert.deepEqual(await onRelay(setup.relay, setup.garden), { "Welcome.md": "Hi Scott and Boris.\n" });
	});

	it("asks once for a folder whose children's events arrive too", async () => {
		const { mounts, files, moves } = await mounted();
		files.files.set("Private/Notes/Ideas/a.md", "a\n");
		files.files.set("Private/Notes/Ideas/b.md", "b\n");
		mounts.created("Private/Notes/Ideas/a.md");
		mounts.created("Private/Notes/Ideas/b.md");
		await mounts.idle();
		await files.rename("Private/Notes/Ideas", "Workspaces/SCN Development/Ideas");
		mounts.renamed("Private/Notes/Ideas/a.md", "Workspaces/SCN Development/Ideas/a.md", false);
		mounts.renamed("Private/Notes/Ideas", "Workspaces/SCN Development/Ideas", true);
		mounts.renamed("Private/Notes/Ideas/b.md", "Workspaces/SCN Development/Ideas/b.md", false);
		await mounts.idle();
		assert.equal(moves.length, 1);
		assert.equal(moves[0].notes, 2);
	});

	it("puts back a note moved out of every vault", async () => {
		const { mounts, files, notices } = await mounted();
		await files.rename("Private/Notes/plan.md", "plan.md");
		mounts.renamed("Private/Notes/plan.md", "plan.md", false);
		await mounts.idle();
		assert.equal(files.files.get("Private/Notes/plan.md"), "# Plan\n");
		assert.match(notices[notices.length - 1], /outside your SCN vaults/);
	});
});

describe("vault folders", () => {
	it("are put back when renamed here", async () => {
		const { mounts, files, notices } = await mounted();
		await files.rename("Workspaces", "Shared");
		mounts.renamed("Workspaces", "Shared", true);
		await mounts.idle();
		assert.equal(files.files.get("Workspaces/SCN Development/Welcome.md"), "Hi Scott and Boris.\n");
		assert.match(notices[notices.length - 1], /named in Corliss/);
	});

	it("are downloaded again when deleted here, and nothing is deleted on SCN", async () => {
		const { mounts, files, relay, garden } = await mounted();
		files.files.delete("Workspaces/SCN Development/Welcome.md");
		files.folders.delete("Workspaces/SCN Development");
		mounts.deleted("Workspaces/SCN Development/Welcome.md", false);
		mounts.deleted("Workspaces/SCN Development", true);
		await eventually(() => files.files.get("Workspaces/SCN Development/Welcome.md") === "Hi Scott and Boris.\n", "the download again");
		assert.deepEqual(await onRelay(relay, garden), { "Welcome.md": "Hi Scott and Boris.\n" });
	});
});

describe("migrating from 1.0", () => {
	it("mounts the old vault where its notes were moved, keeping its store", async () => {
		const setup = relayWithTwoVaults();
		const files = new MemoryFiles();
		files.files.set("plan.md", "# Plan\n");
		const stores = new Map([["legacy-notes", new MemoryNoteStore()]]);

		const legacy = legacyRecord(setup.vaults, {}, setup.notes.url, "legacy-notes");
		assert.ok(legacy);
		assert.equal(legacy.record.folder, "Private/Notes");
		await files.rename("plan.md", `${legacy.record.folder}/plan.md`);

		const local = plugin(setup, { files, stores, records: { [legacy.id]: legacy.record } });
		await local.mounts.update(setup.vaults);
		await eventually(() => files.files.has("Workspaces/SCN Development/Welcome.md"), "the workspace to download");
		await local.mounts.idle();
		assert.equal(files.files.get("Private/Notes/plan.md"), "# Plan\n");
		assert.equal(local.saved()[legacy.id].store, "legacy-notes");
		// The moved note matched, so connecting asked nothing.
		assert.deepEqual(local.asked, []);
	});

	it("has nothing to migrate when the relay no longer lists the vault", () => {
		const setup = relayWithTwoVaults();
		assert.equal(legacyRecord(setup.vaults, {}, "automerge:gone", "legacy-notes"), null);
	});
});

describe("one private vault, at Private", () => {
	// The private vault as relay v0.5.0 lists it: the group alone.
	const atPrivate = (vaults: MountVault[]) => [{ ...vaults[0], path: "Private" }, vaults[1]];

	it("moves its folder up into Private, keeping its store, and keeps syncing", async () => {
		const { mounts, files, relay, notes, vaults, saved, asked, stores } = await mounted();
		const store = saved()[notes.documentId].store;
		await mounts.update(atPrivate(vaults));
		await mounts.idle();
		assert.deepEqual(Object.fromEntries(files.files), {
			"Private/plan.md": "# Plan\n",
			"Workspaces/SCN Development/Welcome.md": "Hi Scott and Boris.\n",
		});
		assert.equal(saved()[notes.documentId].folder, "Private");
		assert.equal(saved()[notes.documentId].store, store);
		assert.equal(saved()[notes.documentId].moving, undefined);
		assert.ok(stores.has(store));
		// Nothing to copy or upload, so nothing was asked, and SCN is unchanged.
		assert.deepEqual(asked, []);
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });

		files.files.set("Private/plan.md", "# Plan\nMoved up.\n");
		mounts.fileChanged("Private/plan.md");
		await eventually(async () => (await onRelay(relay, notes))["plan.md"] === "# Plan\nMoved up.\n", "an edit after the move");
		assert.equal(Object.keys(await onRelay(relay, notes)).length, 1);
	});

	it("sets aside files that were in Private but in no vault, unsynced", async () => {
		const { mounts, files, relay, notes, vaults } = await mounted();
		files.files.set("Private/stray.md", "not synced\n");
		await mounts.update(atPrivate(vaults));
		await mounts.idle();
		assert.equal(files.files.get("Private/plan.md"), "# Plan\n");
		assert.equal(files.files.get("Private (outside SCN)/stray.md"), "not synced\n");
		assert.equal(files.files.has("Private/stray.md"), false);
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });
	});

	it("finishes a move cut off part way at the next start", async () => {
		const first = await mounted();
		const id = first.notes.documentId;
		const records = first.saved();
		await first.mounts.stop();
		// Cut off after the old folder went to staging, before the rest.
		const staging = "SCN Sync moving 1";
		await first.files.rename("Private/Notes", staging);
		records[id] = { ...records[id], path: "Private", folder: "Private", moving: { from: "Private/Notes", staging } };

		const again = plugin(first, { files: first.files, records, stores: first.stores });
		await again.mounts.start();
		await again.mounts.idle();
		assert.equal(first.files.files.get("Private/plan.md"), "# Plan\n");
		assert.equal(first.files.hasFolder(staging), false);
		assert.equal(again.saved()[id].moving, undefined);
		assert.deepEqual(again.asked, []);
		assert.deepEqual(await onRelay(first.relay, first.notes), { "plan.md": "# Plan\n" });
	});
});

describe("notes outside every vault", () => {
	it("are counted as not syncing, and only they are", async () => {
		const { mounts, files, relay, notes, garden } = await mounted();
		for (const path of ["2026-11-04.md", "Workspaces/loose.md", "Projects/idea.md"]) {
			files.files.set(path, "only here\n");
			mounts.created(path);
		}
		await mounts.idle();
		assert.deepEqual(mounts.outside().sort(), ["2026-11-04.md", "Projects/idea.md", "Workspaces/loose.md"]);
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });
		assert.deepEqual(await onRelay(relay, garden), { "Welcome.md": "Hi Scott and Boris.\n" });
	});

	it("are not counted before any vault is known", () => {
		const setup = relayWithTwoVaults();
		const files = new MemoryFiles();
		files.files.set("2026-11-04.md", "only here\n");
		const local = plugin(setup, { files });
		assert.deepEqual(local.mounts.outside(), []);
	});

	it("are offered a move into the private vault once, and never moved unasked", async () => {
		const { mounts, files, offers } = await mounted();
		files.files.set("2026-11-04.md", "today\n");
		mounts.created("2026-11-04.md");
		await mounts.idle();
		assert.deepEqual(offers, [{ paths: ["2026-11-04.md"], into: "Private/Notes" }]);

		await files.rename("2026-11-04.md", "Today.md");
		mounts.renamed("2026-11-04.md", "Today.md", false);
		files.files.set("Today.md", "today, edited\n");
		mounts.fileChanged("Today.md");
		await mounts.idle();
		assert.equal(offers.length, 1);
		assert.equal(files.files.get("Today.md"), "today, edited\n");
		assert.deepEqual(mounts.outside(), ["Today.md"]);
	});

	it("are offered once per batch, however many arrive", async () => {
		const { mounts, files, offers } = await mounted();
		for (const name of ["a", "b", "c"]) {
			files.files.set(`Inbox/${name}.md`, `${name}\n`);
			mounts.created(`Inbox/${name}.md`);
		}
		await mounts.idle();
		assert.equal(offers.length, 1);
		assert.deepEqual(offers[0].paths.sort(), ["Inbox/a.md", "Inbox/b.md", "Inbox/c.md"]);
	});

	it("are offered when moved for the first time, if not offered before", async () => {
		const { mounts, files, offers } = await mounted();
		// There before Obsidian started, so never created this session.
		files.files.set("Old.md", "old\n");
		await files.rename("Old.md", "Workspaces/Old.md");
		mounts.renamed("Old.md", "Workspaces/Old.md", false);
		await mounts.idle();
		assert.deepEqual(offers.map((o) => o.paths), [["Workspaces/Old.md"]]);
	});

	it("move into the private vault on a yes, as new notes there", async () => {
		const { mounts, files, relay, notes } = await mounted();
		files.files.set("2026-11-04.md", "today\n");
		mounts.created("2026-11-04.md");
		await mounts.idle();
		assert.equal(await mounts.moveIntoPrivate("2026-11-04.md"), "Private/Notes/2026-11-04.md");
		assert.equal(files.files.has("2026-11-04.md"), false);
		assert.deepEqual(mounts.outside(), []);
		await eventually(async () => (await onRelay(relay, notes))["2026-11-04.md"] === "today\n", "the note to reach the private vault");
		// Its own rename event is not a move by the member.
		mounts.renamed("2026-11-04.md", "Private/Notes/2026-11-04.md", false);
		await mounts.idle();
		assert.equal(Object.keys(await onRelay(relay, notes)).length, 2);
	});

	it("take a free name in the private vault, overwriting nothing", async () => {
		const { mounts, files, relay, notes } = await mounted();
		files.files.set("plan.md", "another plan\n");
		assert.equal(await mounts.moveIntoPrivate("plan.md"), "Private/Notes/plan 1.md");
		assert.equal(files.files.get("Private/Notes/plan.md"), "# Plan\n");
		await eventually(async () => (await onRelay(relay, notes))["plan 1.md"] === "another plan\n", "the renamed note to upload");
		assert.equal((await onRelay(relay, notes))["plan.md"], "# Plan\n");
	});

	it("are not moved while no private vault is listed", async () => {
		const setup = relayWithTwoVaults();
		const local = plugin(setup);
		await local.mounts.update([setup.vaults[1]]);
		await eventually(() => local.files.files.has("Workspaces/SCN Development/Welcome.md"), "the workspace to download");
		local.files.files.set("loose.md", "here\n");
		local.mounts.created("loose.md");
		await local.mounts.idle();
		assert.deepEqual(local.offers, [{ paths: ["loose.md"], into: null }]);
		assert.equal(await local.mounts.moveIntoPrivate("loose.md"), null);
		assert.equal(local.files.files.get("loose.md"), "here\n");
	});

	it("know the private vault offline, from its record", async () => {
		const first = await mounted();
		const records = first.saved();
		await first.mounts.stop();
		const again = plugin(first, { files: first.files, records, stores: first.stores });
		await again.mounts.start();
		assert.equal(again.mounts.privateFolder(), "Private/Notes");
	});
});

describe("dropping on a group folder", () => {
	it("puts back a note moved from a vault onto the workspaces' folder itself", async () => {
		const { mounts, files, relay, notes } = await mounted();
		await files.rename("Private/Notes/plan.md", "Workspaces/plan.md");
		mounts.renamed("Private/Notes/plan.md", "Workspaces/plan.md", false);
		await mounts.idle();
		assert.equal(files.files.get("Private/Notes/plan.md"), "# Plan\n");
		assert.equal(files.files.has("Workspaces/plan.md"), false);
		assert.deepEqual(await onRelay(relay, notes), { "plan.md": "# Plan\n" });
	});

	it("brings a note dropped on the private vault's folder into that vault", async () => {
		const setup = relayWithTwoVaults();
		const local = plugin(setup);
		await local.mounts.update([{ ...setup.vaults[0], path: "Private" }, setup.vaults[1]]);
		await eventually(() => local.files.files.has("Private/plan.md"), "the download");
		await local.mounts.idle();
		local.files.files.set("loose.md", "here\n");
		await local.files.rename("loose.md", "Private/loose.md");
		local.mounts.renamed("loose.md", "Private/loose.md", false);
		await local.mounts.idle();
		assert.equal(local.files.files.get("Private/loose.md"), "here\n");
		await eventually(async () => (await onRelay(setup.relay, setup.notes))["loose.md"] === "here\n", "the note to upload");
	});
});

describe("where new notes go", () => {
	const vaults = ["Private", "Workspaces/SCN Development"];

	it("is asked when new notes land outside every vault, and only then", () => {
		const locations = new MemoryLocations();
		assert.equal(shouldAsk("", "Private", locations, vaults), true);
		locations.location = "current";
		assert.equal(shouldAsk("", "Private", locations, vaults), true);
		assert.equal(shouldAsk("no", "Private", locations, vaults), false);
		assert.equal(shouldAsk("", null, locations, vaults), false);
		locations.setNewNotes("Workspaces/SCN Development/Inbox");
		assert.equal(shouldAsk("", "Private", locations, vaults), false);
		locations.setNewNotes("Elsewhere");
		assert.equal(shouldAsk("", "Private", locations, vaults), true);
	});

	it("puts new notes and daily notes in the private vault on a yes", async () => {
		const locations = new MemoryLocations();
		assert.equal(await putNewNotesIn("Private", locations, vaults), false);
		assert.equal(newNotesSync(locations, vaults), true);
		assert.equal(locations.folder, "Private");
		assert.equal(locations.daily, "Private");
	});

	it("leaves a daily notes folder already in a vault where it is", async () => {
		const locations = new MemoryLocations();
		locations.daily = "Workspaces/SCN Development/Journal";
		await putNewNotesIn("Private", locations, vaults);
		assert.equal(locations.daily, "Workspaces/SCN Development/Journal");
	});

	it("leaves daily notes it cannot reach to the member, and does not touch them", async () => {
		const unreachable = new MemoryLocations();
		unreachable.daily = undefined;
		assert.equal(await putNewNotesIn("Private", unreachable, vaults), true);
		assert.equal(unreachable.daily, undefined);
		assert.equal(unreachable.folder, "Private");

		const off = new MemoryLocations();
		off.daily = null;
		assert.equal(await putNewNotesIn("Private", off, vaults), false);
		assert.equal(off.daily, null);
	});
});
