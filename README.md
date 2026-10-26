# SCN Sync

SCN Sync keeps a vault of Markdown notes in step with your notes on the
Shared Computer Network, on desktop and iPhone. Notes written on SCN, on
other devices or by Claude arrive as files, and edits, new notes, renames,
moves and deletes made anywhere reach everywhere else, merging with anything
made meanwhile.

## What it needs

- An SCN membership. Signing in goes through Corliss, and access stops when
  the membership does.
- A vault created on Corliss's Notes page, and the sync URL shown there.
- A new, empty Obsidian vault to connect it to.

## Set up

1. In Obsidian, open Settings, Community plugins, Browse. Search for
   "SCN Sync", then Install and Enable.
2. In the setup window, paste the sync URL from the Notes page of your SCN
   site and tap Sign in, then Open SCN sign-in.
3. Sign in at SCN, and return to Obsidian.
4. Choose your vault and tap Connect.

Keep the vault out of iCloud. Two sync tools on one folder fight over the
files.

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
end-to-end encrypted: SCN's operators can read them.

## Development

```
npm install
npm test
npm run build
```

`npm run build` type-checks and writes `main.js` at the repo root. `npm run
dev` rebuilds it on every change. A release is built this way by GitHub
Actions when its version tag is pushed, from the tagged commit after `npm
ci`, and its files carry GitHub artifact attestations.

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
