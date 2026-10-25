# scn-obsidian

Obsidian on the Shared Computer Network. This repo will hold **SCN Sync**, an
Obsidian plugin (id `scn-sync`) that keeps a vault of plain markdown files in
step with Automerge documents on
[scn-sync-relay](https://github.com/Z-Space-Society/scn-sync-relay), on laptop
and iPhone, signed in through
[Corliss](https://github.com/Z-Space-Society/Corliss).

## Status: download only

SCN Sync signs in through Corliss, connects an Obsidian vault to one of the
member's relay vaults, and keeps the files up to date with it: notes written
on SCN, on other devices or by Claude arrive as files. Edits made in
Obsidian are not sent yet, and a note edited here stops taking changes from
SCN until they are. The build order is in issue #2. The spec is at
[`docs/specs/0001-spec-scn-sync/`](docs/specs/0001-spec-scn-sync/0001-spec-scn-sync.md).

## Build

```
npm install
npm test
npm run build
```

`npm run build` type-checks and writes `main.js` at the repo root. `npm run
dev` rebuilds it on every change. The tests run under Node's own test
runner, with no framework, and cover what does not need Obsidian.

To load a development build on a laptop, make a new, empty Obsidian vault
and link this repo in as its plugin folder:

```
ln -s "$PWD" "<vault>/.obsidian/plugins/scn-sync"
```

Then enable SCN Sync under Community plugins and reload Obsidian after each
build. Disable the probe first if it is installed in the same vault: both
register `obsidian://scn-obsidian`.

Also here is [`probe/`](probe/README.md), a throwaway plugin that tests on
a real iPhone the things the design depends on and that could not be settled
from Obsidian's documentation: the `obsidian://` sign-in return, storage
durability, sockets across app suspension, and Automerge's WebAssembly load
time.

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
