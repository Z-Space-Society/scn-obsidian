# scn-obsidian

Obsidian on the Shared Computer Network. This repo will hold **SCN Sync**, an
Obsidian plugin (id `scn-sync`) that keeps a vault of plain markdown files in
step with Automerge documents on
[scn-sync-relay](https://github.com/Z-Space-Society/scn-sync-relay), on laptop
and iPhone, signed in through
[Corliss](https://github.com/Z-Space-Society/Corliss).

## Status: in testing on the iPhone

SCN Sync signs in through Corliss, connects an Obsidian vault to one of the
member's relay vaults, and keeps the two in step: notes written on SCN, on
other devices or by Claude arrive as files, and edits, new notes, renames,
moves and deletes made anywhere reach everywhere else, merging with anything
made meanwhile. It is not yet in Obsidian's community directory. The build
order is in issue #2, the listing in issue #1. The spec is at
[`docs/specs/0001-spec-scn-sync/`](docs/specs/0001-spec-scn-sync/0001-spec-scn-sync.md).

## What it needs

- An SCN membership. Signing in goes through Corliss, and access stops when
  the membership does.
- A vault created on Corliss's Notes page, and the sync URL shown there.
- A new, empty Obsidian vault to connect it to.

## Network use

SCN Sync contacts two services and nothing else:

- **The relay** at the sync URL: its sign-in metadata and vault list over
  HTTPS, and the sync itself over a WebSocket to the same host.
- **Corliss**, the sign-in server the relay names: the browser sign-in, and
  token requests and renewals.

It sends no telemetry and loads no code at runtime.

## Privacy

Notes are stored on the relay as Automerge documents. They are not
end-to-end encrypted: SCN's operators can read them.

## Build

```
npm install
npm test
npm run build
```

`npm run build` type-checks and writes `main.js` at the repo root. `npm run
dev` rebuilds it on every change. A release's `main.js` is built this way
from the tagged commit, after `npm ci`.

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
