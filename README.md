# SCN Sync

Sync your Obsidian vault with the Shared Computer Network (SCN) to mirror edits, new notes, renames, moves and deletions across desktop and iPhone while merging concurrent changes. Sign in with an SCN membership via Corliss; notes are stored as Automerge documents on the relay and are not encrypted at rest.

## What it needs

- An SCN membership. Signing in goes through Corliss, and access stops when
  the membership does.
- The sync URL shown on Corliss's Notes page. Your private vault is there
  from the start, and each workspace you are in has its own.

## Set up

1. In Obsidian, open Settings, Community plugins, Browse. Search for
   "SCN Sync", then Install and Enable. Or open its listing,
   https://community.obsidian.md/plugins/scn-sync, and choose Add to
   Obsidian.
2. In the setup window, paste the sync URL from the Notes page of your SCN
   site and tap Sign in, then Open SCN sign-in.
3. Sign in at SCN, and return to Obsidian.

## Where your notes go

Every vault you can open syncs into this one Obsidian vault, each in its own
folder:

- `Private/` for your private vault. Only you can read these notes.
- `Workspaces/<name>/` for each workspace you are in. Everyone in the
  workspace reads and edits these notes. `Workspaces/` is there even before
  you join one.

Notes anywhere else in the vault stay on this device. The status lists them as
not syncing, and SCN Sync offers to move a new note or folder into `Private/`;
nothing moves unless you say so. Obsidian puts new notes, daily notes and
notes made from a link at the top of the vault by default, so SCN Sync points
them at `Private/` once, and says so; change it back under Obsidian's Files
and links settings. SCN Sync also replaces Obsidian's `Welcome.md` with its
own, which stays on this device. Joining a workspace adds
its folder; leaving one stops it syncing and keeps its files. Moving a note
from one vault's folder into another's asks first, and makes it a new note
there. Vault folders are named and removed in Corliss, so renaming or deleting
one here is undone.

Updating from 1.0 moves the notes of the vault you had connected into
`Private/`. Since 1.2 each member has one private vault, at `Private/` itself:
a vault synced at `Private/<name>/` moves up into `Private/` once the relay
lists it there, with nothing downloaded or uploaded again.

## Network use

SCN Sync contacts two services and nothing else:

- **The relay** at the sync URL: its sign-in metadata and vault list over
  HTTPS, and the sync itself over a WebSocket to the same host.
- **Corliss**, the sign-in server the relay names: the browser sign-in, and
  token requests and renewals.

It sends no telemetry, and does not install or update itself or its
dependencies.

## Privacy

Notes are stored on the relay as Automerge documents. They are not
encrypted at rest.

## Development

```
npm install
npm test
npm run build
```

`npm run build` type-checks and writes `main.js` at the repo root. `npm run
dev` rebuilds it on every change. A release is cut with
`gh release create X.Y.Z --generate-notes`, the tag a bare version matching
`manifest.json`. Publishing it runs GitHub Actions, which builds from the
tagged commit after `npm ci` and the tests, and attaches `main.js`,
`manifest.json` and `styles.css` with GitHub artifact attestations. The
release is installable once they are attached.

`main.js` is about 5 MB because Automerge's WebAssembly is inlined in it as
base64. It comes from `@automerge/automerge` 3.5.0, the file
`automerge.wasm.base64`, pinned in `package-lock.json`. The tests run under Node's own test
runner, with no framework, and cover what does not need Obsidian.

To load a development build on a laptop, make a new, empty Obsidian vault
and link this repo in as its plugin folder:

```
ln -s "$PWD" "<vault>/.obsidian/plugins/scn-sync"
```

Then enable SCN Sync under Community plugins and reload Obsidian after each
build.

The design is in the spec at
[`docs/specs/0001-spec-scn-sync/`](docs/specs/0001-spec-scn-sync/0001-spec-scn-sync.md).
Bugs and requests go to this repo's issues on GitHub.

## Names

| Thing | Value |
|---|---|
| Repo | `scn-obsidian` |
| Plugin id | `scn-sync` |
| Plugin name | SCN Sync |
| Sign-in redirect | `obsidian://scn-obsidian` |

Obsidian's community directory does not accept a plugin id containing
`obsidian`, which is why the plugin and the repo have different names.

## License

Apache-2.0. See [LICENSE](LICENSE).
