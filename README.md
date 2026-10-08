# scn-obsidian

Obsidian on the Shared Computer Network. This repo will hold **SCN Sync**, an
Obsidian plugin (id `scn-sync`) that keeps a vault of plain markdown files in
step with Automerge documents on
[scn-sync-relay](https://github.com/Z-Space-Society/scn-sync-relay), on laptop
and iPhone, signed in through
[Corliss](https://github.com/Z-Space-Society/Corliss).

## Status: probe only

The plugin is not written yet. Its spec is drafted at
[`docs/specs/0001-spec-scn-sync/`](docs/specs/0001-spec-scn-sync/0001-spec-scn-sync.md).

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
