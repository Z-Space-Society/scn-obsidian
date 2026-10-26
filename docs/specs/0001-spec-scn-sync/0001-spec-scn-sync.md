# 0001 Spec: SCN Sync (the Obsidian plugin)

Status: implemented. Drafted 2026-10-08 and revised 2026-10-24 against relay
v0.2.1, which shipped after the first draft. SCN Sync was released through
BRAT from 0.2.0 and listed in Obsidian's community directory at 1.0.2 on
2026-10-26.

## Goal

An Obsidian plugin that keeps one Obsidian vault of plain `.md` files in step
with one vault on scn-sync-relay, in both directions, on the laptop and on
the iPhone.

1. A member signs in through Corliss, picks one of their vaults, and the
   notes appear as ordinary files.
2. An edit made in Obsidian, in any other editor on the laptop, or by Claude
   through the relay's MCP service reaches every other place, and concurrent
   edits merge instead of overwriting.
3. Access works while you are an SCN member and stops when you are not.

The files are what the member reads and edits. The Automerge documents
underneath are what let edits merge.

## Non-goals

- Creating, renaming or deleting a vault. Vaults are created on Corliss's
  Notes page. The plugin only connects to one.
- Sharing a vault between members.
- Importing an existing Obsidian vault in place. A vault that already holds
  notes can be connected (V3), and nothing beyond that is built.
- Syncing anything but `.md` files. `.canvas`, `.base` and attachments come
  soon after and are designed for in the schema (D4), not built here.
- Syncing Obsidian's config folder, ever.
- Editing notes outside Obsidian on iOS. It is a laptop case.
- Being an MCP server. The MCP service lives in the relay.
- End-to-end encryption. The relay can read every note.
- Pointing members at BRAT. Members install SCN Sync from Obsidian's
  community directory; see "Distribution". BRAT is how development and
  proof-of-concept builds reach a laptop or an iPhone, and nothing a member
  reads mentions it.

## Scope and order

Laptop first. The iPhone runs the same code, and section "Desktop and iOS"
lists every place the two differ. Claude does not depend on this plugin:
with a vault created on the web, the MCP service works on its own.

## Where the facts come from

- What an Obsidian plugin can and cannot do, and the iPhone results:
  `scnvault/Projects/scn-obsidian/plugin-ui-research.md`.
- What the relay expects of a client:
  `scn-sync-relay/docs/specs/0001-spec-phase-b/0001-spec-phase-b.md`.
- The OAuth client and token contract:
  `Corliss/docs/specs/0001-spec-multi-client-oauth/0001-spec-multi-client-oauth.md`.

A statement below marked **unverified** has not been tested. Each one has an
entry in the test plan.

## Names and versions

| Thing | Value |
|---|---|
| Repo | `scn-obsidian` |
| Manifest `id` | `scn-sync` |
| Display name | SCN Sync |
| `minAppVersion` | `1.13.0`, for the declarative settings tab and `setDestructive` |
| `isDesktopOnly` | `false` |
| OAuth `client_id` | `<issuer>/clients/scn-obsidian.json` |
| Redirect URI | `obsidian://scn-obsidian` |
| Secret ID | `scn-sync-refresh-token` |

Pinned dependencies, exact versions, no ranges:

| Package | Version |
|---|---|
| `@automerge/automerge-repo` | 2.5.6 |
| `@automerge/automerge-repo-network-websocket` | 2.5.6 |
| `@automerge/automerge-repo-storage-indexeddb` | 2.5.6 |
| `@automerge/automerge` | 3.5.0, what 2.5.6 resolves to today |
| `uuid` | 11.1.1, by `overrides` in `package.json` |

- The plugin speaks the classic automerge-repo WebSocket sync protocol, the
  one samod serves. It must never move to a Subduction release
  (`2.6.0-subduction.*`, `2.7.0-authors.*`), which the relay does not host.
- npm's `latest` tag for `@automerge/automerge-repo` points at a prerelease.
  An unpinned install gets the wrong line.
- automerge-repo 2.5.6 asks for uuid ^9, which carries an advisory for
  `v3`, `v5` and `v6` with a buffer. It calls only `v4`, `validate` and
  `parse`, the same in uuid 11, and every automerge-repo that moved off
  uuid 9 is a prerelease. The override clears the advisory.
- A dependency bump is a change to this spec and needs a sync test against
  the deployed relay.

## Distribution

Members install from Obsidian's community directory, which works the same on
desktop and iOS and updates the plugin itself. SCN Sync is listed at
https://community.obsidian.md/plugins/scn-sync, published 2026-10-26 at
1.0.2. What a listing takes is in issue #1. In short:

- `manifest.json` at the repo root, and a GitHub release per version whose
  tag is exactly the manifest version, carrying `main.js`, `manifest.json`
  and `styles.css` when there is one. The tag `0.0.1` belonged to the retired probe.
  The first SCN Sync release is `0.2.0`.
- The README discloses network use (Corliss and the relay, nothing else),
  that an SCN membership is required, and that notes are not end-to-end
  encrypted.
- `main.js` builds from source with a documented command, since reviewers
  will ask about a 5 MB bundle with inlined WASM.

Test builds reach devices through BRAT. The listing keeps its own copy of
the README: a push to `main` does not change it.

## Build and bundling

- One CommonJS `main.js` built with esbuild, as in
  `obsidian-sample-plugin`. A release carries `main.js`, `manifest.json` and
  `styles.css` when there is one. Obsidian downloads nothing else. SCN
  Sync's `styles.css` lays out the sync URL field; everything else uses
  Obsidian's own classes. No styles are set from code.
- Automerge is imported from `@automerge/automerge/slim` and
  `@automerge/automerge-repo/slim`. The WASM is inlined from
  `@automerge/automerge/automerge.wasm.base64` and started with
  `initializeBase64Wasm`. In 3.5.0 that import path has no `.js` suffix.
- The WASM is 3.64 MB and `main.js` comes to about 5 MB. On the iPhone it
  initialised in 66 ms.
- `onload` only registers things: the protocol handler, commands, the
  settings tab, the ribbon icon. The WASM, the repo, IndexedDB and the
  socket start inside `workspace.onLayoutReady`.
- No Node or Electron API anywhere. Hashing uses `SubtleCrypto`.
- The build must leave no `require` in `main.js` other than `obsidian`.
- cbor-x, automerge-repo's message encoder, is bundled from its own
  `cbor-x/index-no-eval` build, so `main.js` has no `new Function`. The
  wire format is the same.
- A release is built, attested and published by
  `.github/workflows/release.yml` when its bare version tag is pushed. The
  release notes are the annotated tag's message.

## Setup and first run

What the member does, in order. Steps marked **user** are ones the plugin
cannot do.

1. **User:** on Corliss's Notes page (`/notes/`), create a vault. Copy
   the sync URL shown there.
2. **User:** in Obsidian, open the vault to connect, or create one.
3. **User:** install SCN Sync from Community plugins and enable it. Test
   builds come through BRAT instead.
4. The plugin opens its setup modal from `onUserEnable`.
5. The member pastes the sync URL and taps Sign in, then Open SCN sign-in.
   The browser opens, Corliss signs them in, and control returns to
   Obsidian.
6. The plugin lists the member's vaults. The member picks one.
7. Sync starts. Existing notes download. The member moves notes in as they
   choose.

The setup modal:

- Says what the plugin does and that notes are not end-to-end encrypted.
- Checks whether the vault has `.md` files. If it has, it says how many and
  that nothing is overwritten: a note that differs is kept as a copy (V3).
- Every step is also in the settings tab, so a dismissed modal loses
  nothing.

If the member has no vault, the plugin says so and links to the Obsidian
page. It never creates one.

## Sign-in

### S1. Discovery

The member gives one value, the sync URL. From it the plugin needs the
issuer.

- The sync URL is stored in the form `https://<sync host>`. A pasted `wss://`
  is accepted and rewritten. The socket uses `wss://<sync host>/`.
- The plugin fetches
  `https://<sync host>/.well-known/oauth-protected-resource` and reads
  `authorization_servers[0]` as the issuer and `resource` as the audience.
  The relay serves that document on the sync listener from v0.2.1.
- From the issuer it fetches `/.well-known/oauth-authorization-server` and
  reads the authorize and token endpoints.
- The settings tab has an Advanced field for the issuer, used when discovery
  fails.

### S2. Authorization request

- Public client, `client_id` `<issuer>/clients/scn-obsidian.json`.
- `response_type=code`, `redirect_uri=obsidian://scn-obsidian`,
  `scope=offline_access`, `resource=<the audience>`,
  `code_challenge_method=S256`.
- `state` and the PKCE verifier are 32 random bytes each from
  `crypto.getRandomValues`.
- **Before the browser opens**, the plugin saves `{state, verifier, issuer,
  syncUrl, startedAt}` with `app.saveLocalStorage`. iOS may end Obsidian
  while the browser is in front, and the callback then starts a fresh plugin
  instance. Tested: a cold-start callback matched its saved state.
- The browser is opened with `window.open(url)`, called straight from a
  tap. iOS ignores it once the tap has waited on the network, as discovery
  does, so sign-in takes two taps: Sign in runs S1 and builds the request,
  then Open SCN sign-in opens it. Found on the iPhone with 0.2.0.
- A pending sign-in is valid for 10 minutes and is cleared with
  `saveLocalStorage(key, null)` when used or expired.

### S3. Callback

`registerObsidianProtocolHandler("scn-obsidian", ...)`, registered in
`onload` so a cold start still receives it.

| Callback | Plugin does |
|---|---|
| `state` matches a pending sign-in, `code` present | Exchange the code |
| `error` present | Show Corliss's error. Clear the pending sign-in. |
| No pending sign-in, or `state` differs | Show "this sign-in was not started in this vault". Change nothing. |

With two vaults open on the desktop the callback can reach the wrong one.
The state check is what catches that.

A member who is not an SCN member is sent to Corliss's home page and no
callback arrives. The pending sign-in simply expires, and the modal says to
check membership if nothing came back.

### S4. Tokens

- The code is exchanged at the token endpoint with `requestUrl`: `grant_type`,
  `code`, `redirect_uri`, `client_id`, `code_verifier`.
- **All HTTP uses `requestUrl`.** Plain `fetch` is blocked by CORS in the iOS
  webview. Tested.
- The **refresh token** goes to `app.secretStorage` as
  `scn-sync-refresh-token`. Never to `data.json`: that file sits in the
  config folder, another sync tool could copy it to a second device, and a
  refresh token used from two devices trips Corliss's reuse rule and ends the
  whole family.
- The **access token** lives in memory only.
- The token's `sub` is the member's DID. It is saved in `data.json` and
  checked on every sign-in; see V4.

### S5. Refresh

- One refresh at a time. A second caller waits for the first.
- Refresh at `exp` minus 60 seconds, and whenever a token is needed and the
  one in memory has under 60 seconds left.
- **Store the new refresh token before using the new access token.**
  `setSecret` is synchronous.
- **A lost response is retried with the same refresh token.** A timeout or a
  dropped connection is not a failure of the grant. Corliss accepts a repeat
  within 60 seconds of first use. Retries back off at 1, 2, 4 and 8 seconds,
  then stop until the next trigger.
- **`invalid_grant` means signed out.** Sync stops, the stored token is
  cleared, every local file and document is kept, and the status says to
  sign in again. This is also what a removed member sees.
- Any other error is treated as the network being down. Sync pauses and
  retries.

### S6. Sign out

Stops sync, closes the socket, clears the access token and the stored
refresh token. Local files and documents are kept. `SecretStorage` has no
delete call in the API types, so clearing writes an empty value; see open
question 5.

## Document schema

This answers the relay spec's open question 1. The shapes follow
[Pushwork](https://github.com/inkandswitch/pushwork)'s `patchwork-folder`
and file shapes (`src/shapes/patchwork-folder.ts`, `src/shapes/types.ts`),
so other Automerge tools can read the same tree.

### D1. Folder document

```
{
  "@patchwork": { "type": "folder" },
  "title": "<folder name; the vault name on the root>",
  "docs": [
    { "name": "<file or folder name>", "type": "<see D3>", "url": "automerge:<id>" }
  ]
}
```

- `docs` is the key that holds the entries. It is an Automerge list.
- Every string the relay writes, in this document and in D2 (`title`,
  `name`, `type`, `extension`, `mimeType`, and each entry's `name`, `type`
  and `url`), is an Automerge **text object**, not a scalar string
  (`reach::put_string` in the relay). A reader accepts either. The plugin
  writes text objects, as the relay does.
- A vault's root is a folder document. Its `title` is the vault's name at
  creation and is not kept in step afterwards.

### D2. Note document

```
{
  "@patchwork": { "type": "file" },
  "name": "<file name with extension>",
  "extension": "md",
  "mimeType": "text/markdown",
  "content": "<the file's text>"
}
```

- `content` is the key that holds a note's text. It is an Automerge **text
  object**, edited with splices. It is never a scalar or immutable string,
  and no writer replaces it whole.
- `content` is the file's text exactly, frontmatter and line endings
  included. Nothing is normalised.
- `name` in the document is a convenience copy. The folder entry's `name`
  is the authority for where a note lives.

### D3. Entry type and the per-document type field

- Every document carries `"@patchwork".type`: `folder` or `file`. This is
  the type field per document.
- A folder entry's `type` is `folder` for a folder and the file's extension
  for a file: `md` for a note.
- A reader that meets a `"@patchwork".type` or an entry `type` it does not
  know skips that document and leaves it untouched.

### D4. Room for what comes next

No note needs migrating when these arrive, because each is a new value in a
field that already exists:

| Later | Document | Entry `type` |
|---|---|---|
| `.canvas`, `.base` as text | `file`, same shape, `extension` and `mimeType` set | `canvas`, `base` |
| `.canvas`, `.base` with their own structure | a new `"@patchwork".type` | `canvas`, `base` |
| Attachments in Automerge | `file`, with `content` as bytes | the extension |
| Attachments as blobs | a new `"@patchwork".type` holding a reference | the extension |

For the MVP the plugin and the relay act only on entries of type `folder`
and `md`.

### D5. Names

- A `name` is one path segment. It is never empty, never `.` or `..`, never
  contains `/`, and never starts with a dot.
- Names are stored in Unicode NFC.
- Two names in one folder **collide** when they are equal after NFC and case
  folding. macOS and iOS file systems cannot hold both.
- A name the local file system refuses is skipped and reported, never
  rewritten.

### D6. Wording to copy into the relay spec

Replace open question 1 in the relay spec with a section, and delete the
question:

> **Document schema.** Settled in the scn-obsidian plugin spec, sections D1
> to D5, and repeated here.
>
> - A folder document is `{"@patchwork": {"type": "folder"}, "title", "docs"}`.
>   `docs` is a list of entries `{name, type, url}`.
> - A note document is `{"@patchwork": {"type": "file"}, "name", "extension":
>   "md", "mimeType": "text/markdown", "content"}`. `content` is an Automerge
>   text object holding the file's text exactly.
> - An entry's `type` is `folder`, or the file's extension. The relay acts on
>   `folder` and `md` and ignores every other entry: it does not walk it,
>   list it, search it or admit it to a vault's reachable set.
> - A name is one path segment: not empty, not `.` or `..`, no `/`, no
>   leading dot, stored in NFC. `create_note` refuses any other name, and
>   refuses a name that collides with an existing entry after NFC and case
>   folding.
> - **Path resolution with duplicate names.** When a folder holds two entries
>   whose names collide, the entry whose `url` sorts lowest as a string is
>   the one the path refers to. Clients rename the others; see the plugin
>   spec, T4.
> - Vault creation writes a root folder document with `title` set to the
>   vault's name and an empty `docs` list.
> - `create_note` writes the note document first, then appends the entry.
>   `edit_note` and `append_note` splice `content` and never replace it.
> - Text positions are computed in whatever unit the relay's Automerge build
>   uses, by the relay, on the document it holds. No position crosses the
>   wire.

## Local state

### L1. What is stored where

| What | Where | Why there |
|---|---|---|
| Automerge documents | IndexedDB, through automerge-repo's storage adapter, in a database named `scn-sync-<storeId>` | Decision 12 |
| Per-note sync state (L2) | IndexedDB, the plugin's own database `scn-sync-<storeId>-notes` | Lost with the documents, since eviction takes an origin's storage whole |
| Sync URL, issuer, member DID, vault root URL, vault name, `storeId` | `data.json` | Must survive a lost IndexedDB |
| Refresh token | `SecretStorage` | S4 |
| Pending sign-in | `app.saveLocalStorage` | S2 |

IndexedDB belongs to Obsidian's origin and is shared by every vault it
opens, so each Obsidian vault names its databases by a random `storeId`,
made at the first connect. Disconnect deletes both databases and clears
`storeId`, so the next connect runs V3 from nothing.

On iOS the plugin calls `navigator.storage.persist()` at startup and ignores
the answer. It was refused in testing. IndexedDB is treated as a cache of
the relay.

### L2. Per-note state

One record per synced file, keyed by path:

| Field | Meaning |
|---|---|
| `path` | Vault path of the file |
| `url` | The note's document |
| `syncedHash` | SHA-256 of the text the plugin last wrote to, or read from, the file |
| `syncedHeads` | The document's heads at that moment |
| `offlineEdit` | True while the note holds an edit made with no connection that has not yet had a connection to travel on (T5) |

`syncedHash` and `syncedHeads` are always written together. Between them
they define the **base**: the text both the file and the document agreed on.

### L3. A lost store

Detected at startup: `data.json` names a vault root, and the per-note store
is empty or missing.

The plugin does not treat the files as new notes. It runs the connect
procedure, V3, against the vault it was already connected to.

## Connecting to a vault

### V1. Listing

`GET https://<sync host>/vaults` with the access token as a bearer, through
`requestUrl`. The answer is `{"vaults": [...]}`, the member's own, each with
`root_doc_id`, `url` (`automerge:<root_doc_id>`), `name`, `created_at` and
`last_change_at`, which is null for a vault never changed.

### V2. Picking

The member picks one. The plugin saves its root URL and name in `data.json`.
One Obsidian vault connects to one relay vault. Changing it is "Disconnect"
followed by a new connect, and Disconnect keeps every file.

### V3. The connect procedure

Used for a first connect and for a lost store.

1. Request the root document and walk every folder document. This yields the
   relay's tree: path to document URL.
2. For each note in the tree, request its document.
3. For each note in the tree, compare with the local file at that path:

| Local file | Action |
|---|---|
| None | Write the file. Record state. |
| Text equals the document's | Adopt it. Record state. Nothing is written. |
| Text differs | Keep the local file under a new name, `<name> (local copy <date>).md`, then write the relay's text at the original path. Record state for the original path. The copy is then an ordinary new file. |

4. Every local `.md` file with no entry in the tree is a new note and goes
   out through the normal outbound path (O3).

A member is told how many notes will be downloaded, adopted, copied and
uploaded before step 3 runs, and confirms. Nothing in this procedure deletes
or overwrites a local file without a copy.

### V4. One member per local store

`data.json` records the DID that connected the vault. If a later sign-in
returns a different DID, the plugin refuses to sync and says the vault is
connected as another member. The member disconnects first. Without this,
every push would be denied by the relay one document at a time.

## The sync loop

The plugin holds one automerge-repo `Repo` with the IndexedDB storage
adapter and, while connected, one WebSocket client adapter.

### O1. What triggers work

| Trigger | Work |
|---|---|
| `vault.on('modify')` for a `.md` file | Outbound for that note |
| `vault.on('create')`, `('delete')`, `('rename')` | Structure change (T1 to T5) |
| A document's `change` event from the repo | Inbound for that note |
| A folder document's `change` event | Inbound structure change |
| Startup, after the repo is open | Reconciliation (O6) |
| Editor change in an open note | Outbound through the editor (O5) |

Vault events are registered inside `onLayoutReady`, which skips the `create`
event Obsidian fires for every existing file at load.

A note moved in Finder while Obsidian runs reaches the plugin as a `delete`
and a `create`, not a `rename` (check 6, 2026-10-26). It is sent as a delete
and a new note with the same text: nothing is lost, but the note gets a new
document, its history stays with the old one, and other devices see the file
go to the trash and a new one appear. A move made in Obsidian keeps the
document.

All work for one note runs through one queue for that note, so outbound and
inbound never interleave.

### O2. The base rule

**Diff against the base, apply at the base.** The plugin never compares an
edited file with the document's current text. A remote change that arrived
since the last sync would look like something the member deleted.

### O3. Outbound: file to document

1. Read the file. Compute its hash.
2. If the hash equals `syncedHash`, stop. This is the plugin's own write
   coming back, or a save with no change.
3. Get the base text: the document viewed at `syncedHeads`.
4. Diff base text against file text into splices.
5. Apply the splices with `handle.changeAt(syncedHeads, ...)`. Automerge
   merges them with anything newer.
6. Read the document's text after the merge.
7. If it equals the file's text, record `syncedHash` and `syncedHeads` and
   stop.
8. If it differs, a remote change was merged in. Continue as inbound from
   step 3 of O4.

A new file has no base. The plugin creates the note document with the file's
text as `content`, then adds the entry to its folder document, creating
folder documents for any new folders on the way. Document first, entry
second, matching the relay's admission rule.

Bulk adds are queued and worked through a few at a time. Entries for many
new files in one folder are added in one change to that folder document.

Create, delete and rename events are collected for 50 ms and handled as one
batch, folders before files and shallowest first. A file event inside a
folder already handled in the batch is dropped, so a folder rename or delete
is one entry edit whether Obsidian reports it as one event, or as one per
file in either order. A walk that began before a structure change made here
is thrown away, so it cannot bring back a path just renamed or deleted.

### O4. Inbound: document to file

1. A change arrives on a note document.
2. Read the file and compute its hash. If it differs from `syncedHash`, the
   member has an edit the plugin has not processed yet. Run outbound first,
   which merges both, and continue with its result.
3. Take the document's text.
4. If the note is open in an editor, write through the editor (O5).
   Otherwise write the file with `vault.process`.
5. Record `syncedHash` as the hash of what was written and `syncedHeads` as
   the document's heads.

Inbound writes are coalesced: a burst of changes to one note produces one
write.

### O5. A note open in the editor

A plain file write to the note being typed in loses the cursor and can lose
keystrokes Obsidian has not saved yet. For a note open in a Markdown editor,
the editor's buffer stands in for the file:

- **Outbound** reads `editor.getValue()` on editor changes, debounced, and
  runs O3 with the buffer as the file text.
- **Inbound** flushes the buffer outbound first, then applies the difference
  between the buffer and the merged text as an editor transaction of minimal
  changes, so the cursor and selection hold their place.
- `syncedHash` is set to the hash of the merged text. When Obsidian then
  saves the buffer to disk, the `modify` event carries that same hash and is
  ignored by O3 step 2.

- Both are inside the plugin's file access: reading a note open in an editor
  returns the buffer, and writing to it applies each change with
  `editor.replaceRange`, last first. A write only lands if the file or buffer
  still holds what was read; otherwise the note is queued again with the
  newer text, so keystrokes typed meanwhile are never undone.

Verified by check 5 on 2026-10-26, with 1.0.2: typing in a note while an
MCP append arrived kept the cursor and every keystroke, and both sides held
the same text. The fallback, delaying an inbound write to an open note until
the member stops typing, is not needed.

### O6. Startup reconciliation

Runs once after the repo is open, before live events are acted on. Events
that arrive meanwhile are queued.

| Finding | Action |
|---|---|
| File present, state present, hash equals `syncedHash` | Nothing |
| File present, state present, hash differs | Outbound (O3) |
| File present, no state | A new note (O3) |
| State present, file missing | A local delete (T3) |
| Entry in the tree, no file, no state | Download: write the file, record state |

**Guard against a vanished vault.** If more than 20 files with state are
missing and they are over half of all files with state, the plugin stops,
propagates no delete, and asks the member. A vault folder that was moved or
not yet mounted must not empty the relay. The member either deletes them on
the relay too, or downloads them again; closing the question downloads them,
which loses nothing.

This is the only net for changes the plugin did not see as events. On iOS
that includes anything written outside Obsidian.

### O7. Echo suppression

The hash comparison in O3 step 2 is the whole mechanism. Every write the
plugin makes sets `syncedHash` first, so the event it causes is recognised
and dropped. No timers, no list of paths to ignore.

## Structure changes

Folder documents hold the tree. Every structure change is an edit to one or
two folder documents.

### T1. Rename within a folder

Set the entry's `name`. One change to one document, so no other device ever
sees the note at two paths. A folder rename is the same single edit and
moves everything under it.

### T2. Move between folders

Two documents change, so it cannot be atomic. **Add before remove:**

1. Append the entry to the destination folder's `docs`.
2. Remove the entry from the source folder's `docs`.

The mover's per-note state moves to the new path first, with `movedFrom`
set to the old one, and `movedFrom` is cleared after step 2. A state found
with `movedFrom` at startup means the move was cut short, and its old entry
is removed then.

A note seen at two paths in one vault is a move in progress, not a copy. A
device that receives it:

- Has the file at the old path only: waits. When the old entry goes away it
  renames its local file to the new path.
- Has the file at the new path only: it is the mover, or has caught up.
  It removes the old entry if it is still there. This is how a move
  interrupted by a crash is finished at the next start.
- Never writes a second file for the same document.

A device follows a rename or move made elsewhere with `vault.rename`, never
`fileManager.renameFile`, which rewrites links in other notes: two devices
doing that for one rename would double the edit. A folder renamed or moved
elsewhere is renamed here as one folder, so files SCN Sync does not sync go
with it. That needs the folder's previous path, which the plugin knows from
its last walk. Across a restart it does not, and the folder's notes move one
by one, leaving any other files in the old folder.

### T3. Delete

- **Local delete:** remove the entry from its folder document. The note's
  document is left alone. The relay keeps it and no path leads to it.
- **Remote delete:** an entry disappears. If T5 does not apply, the plugin
  removes the local file with `fileManager.trashFile`, which follows the
  member's trash setting, and drops the note's state.
- Deleting a folder removes its one entry. Devices remove the folder and
  everything under it, each file by the rule above.

### T4. Duplicate paths

Two devices, or a device and Claude, can create the same path while apart.
The folder then holds two entries whose names collide (D5).

- The entry whose `url` sorts lowest as a string keeps the path.
- Every other colliding entry is renamed to
  `<base> (conflict <first 6 characters of its document ID>).<ext>` by
  setting its `name`.
- The new name is computed from the entry alone, so every device that sees
  the collision makes the same edit, and concurrent copies of it converge.
- Both notes survive, both sync, and the member merges them by hand.

The relay resolves a colliding path the same way (D6), so Claude and the
plugin agree on which note a path means before the rename lands.

### T5. Delete against a concurrent edit

An edit wins over a delete. Trash is the net when the plugin cannot tell.

When an entry for a note disappears, the plugin restores it, by appending
the entry again, if either holds:

- the local file's hash differs from `syncedHash`, so the member has an edit
  the plugin has not sent yet, or
- the note's `offlineEdit` flag is set.

`offlineEdit` is set when an outbound edit is applied while no connection is
open. It is cleared 30 seconds after a connection opens with that note's
document requested.

Otherwise the file goes to the trash, where the member can get it back.

This is a heuristic. The plugin cannot learn what the relay holds, because
the relay drops the messages that would say so. See open question 3.

## What syncs

- **`.md` files only.** Every other file is left alone: never uploaded,
  never deleted, never renamed.
- **The config folder is always excluded.** Its name comes from
  `vault.configDir`. It is never hardcoded as `.obsidian`.
- **Any path with a dot-prefixed segment is excluded.** That covers
  `.trash/`.
- The plugin lists and watches through the Vault API only, which does not
  expose hidden folders. The two path checks above are a second wall.
- A note over 2 MB of text is skipped and reported. See open question 6.

## Connection behaviour

### N1. Connecting

- `wss://<sync host>/?access_token=<jwt>`. A browser WebSocket cannot set a
  header.
- The token is never logged and never written to disk.
- **The plugin owns reconnection.** The WebSocket client adapter's own retry
  reuses its URL, which carries a token that expires, so it must not be the
  thing that reconnects. On every close the plugin removes the adapter, gets
  a valid token, and adds a new one.
- In 2.5.6 the retry is turned off by overriding the adapter's `onClose`, and
  by a `retryInterval` longer than any connection lives. A `retryInterval` of
  0 does not turn it off: the adapter would reconnect on every tick until a
  socket opened. Read from the 2.5.6 source; check 9 confirms it live.
- Reconnect backs off at 1, 2, 4, 8, 16 and 30 seconds, then stays at 30.

### N2. Token expiry

The relay closes the connection at the token's `exp`, every 15 minutes. The
plugin does not wait for that. Just under 60 seconds before `exp` it closes
the connection, refreshes, and opens a new one with the new token.

**Close first, then open.** The repo's network layer keeps one adapter per
remote peer and ignores a second one for the same peer, and the relay's peer
ID does not change. A new connection opened beside the old one would be
ignored, and the relay would be lost when the old one closed. The cost is a
gap of about a second, every 15 minutes.

### N3. Open every note

The relay never announces. A note the plugin has not requested receives no
remote changes.

- At startup the plugin opens a handle for the root, every folder document
  and every note document. A document that is only in IndexedDB, with no
  open handle, is not synced.
- On each new connection automerge-repo starts sync for every open handle.
- When a folder document gains an entry, the plugin opens that document at
  once.

**The cost.** A vault of N notes is N sync handshakes on every connection,
so N every 15 minutes per device, and the relay keeps each requested
document loaded. This is relay open question 7. The plugin does not
measure it. Nothing here reduces it. The candidates, a longer sync token or renewing a
token on an open connection, belong to the relay and Corliss.

### N4. Return to the foreground

On `visibilitychange` to visible, on both platforms, the plugin assumes the
socket is dead and reconnects, refreshing the token first if needed. It does
not read `readyState`: on the iPhone it still said `OPEN` on a socket that
closed a millisecond later.

### N5. A denied document

The relay answers a frame for a document the member may not open by
dropping it and sending `doc-unavailable`. A denied document and a missing
one look the same.

With V4 in place a member's own notes are never denied. It can still happen:
a document ID that collides with someone else's, a vault whose owner changed
on the relay, or a fault.

- The plugin never deletes or overwrites local data because a document is
  unavailable.
- A note whose document is reported unavailable is marked "not syncing" and
  counted in the status. The file stays editable. Its edits stay in the
  local document.
- Three or more notes unavailable at once is reported as a vault problem,
  with a pointer to Corliss's Notes page.

**Unverified:** what automerge-repo 2.5.6 does when a document it already
holds locally is answered with `doc-unavailable`. Relay open question 2. The
test plan has the experiment, and its result is copied back to the relay
spec.

## Status and errors

Where the member sees state:

| Surface | Shows | Desktop | iOS |
|---|---|---|---|
| Ribbon icon | State at a glance; tap opens the status | yes | yes |
| Status bar item | The same | yes | not available |
| Settings tab | Account, vault, last sync, counts, every action | yes | yes |
| Notices | Only for something the member must act on | yes | yes |

States:

| State | Meaning | Member's action |
|---|---|---|
| Not set up | No sync URL or no sign-in | Finish setup |
| Signed out | No valid refresh token | Sign in |
| No vault | Signed in, none picked | Pick one, or create one on the web |
| Syncing | Connected, work in progress | None |
| Up to date | Connected, queues empty | None |
| Offline | No connection, retrying | None |
| Attention | Notes not syncing, or the vanished-vault guard | Open the status |

Commands: Sign in, Sign out, Open sync status, Reconnect now, Disconnect
this vault.

A removed member sees "Signed out" within one token lifetime. Their files
stay where they are.

## Desktop and iOS

| | Desktop | iOS |
|---|---|---|
| Status bar | Available | Not available. Ribbon and settings only. |
| Edits outside Obsidian | Seen as events, and by startup reconciliation | Not designed for. Startup reconciliation is the only net. |
| Backgrounding | Keeps running | Frozen at once. The socket dies. Reconnect on return (N4). |
| IndexedDB | Durable in practice | Can be evicted. Lost-store recovery (L3) is expected to run sometimes. Check 17 saw it survive 18 days. |
| Sign-in return | The OS hands the address to Obsidian | Safari asks "Open this page in Obsidian?" first. Works from a cold start. |
| Syncs while | Obsidian is running | Obsidian is in the foreground |
| Install, members | Community directory | Community directory |
| Install, development | BRAT, or files copied by hand | BRAT only |
| Lockdown Mode | Not applicable | Unsupported |

Everything else is the same code.

## Module layout

| File | Holds |
|---|---|
| `src/main.ts` | Plugin lifecycle, registration, wiring, the status surfaces |
| `src/auth.ts` | S1 to S6: discovery, PKCE, callback, token exchange, refresh |
| `src/connection.ts` | N1, N2, N4: the socket to the relay and its reconnection |
| `src/relay.ts` | `requestUrl` calls to the relay: vault list |
| `src/schema.ts` | D1 to D5: document shapes, name rules, collision rule |
| `src/tree.ts` | Walking folder documents, path to URL map |
| `src/state.ts` | What is kept in `data.json` |
| `src/notes.ts` | L2 per-note state, and the file access the sync works through |
| `src/idb.ts` | The per-note store in IndexedDB (L1) |
| `src/vaultfiles.ts` | Files through Obsidian's Vault API, and the editor path (O5) |
| `src/diff.ts` | The difference between two texts as splices |
| `src/messages.ts` | An error as the member reads it |
| `src/sync/sync.ts` | V3, O3, O4, O6, and structure changes T1 to T5 |
| `src/sync/structure.ts` | Edits to folder documents and new document shapes |
| `src/ui/` | Setup modal, settings tab, status |

`auth.ts`, `notes.ts` and `sync/` import nothing from `obsidian`, so they run
under `node --test`.

## Requests to the other specs

Things this spec needs that the relay and Corliss specs do not yet say.

Requests 1, 3 and 4 are met by relay v0.2.1.

1. **Done.** **Relay: serve protected resource metadata on the sync listener.**
   `GET /.well-known/oauth-protected-resource` returning `resource` (the
   sync audience) and `authorization_servers` (the issuer), as the MCP
   listener already does. Without it the member pastes two URLs.
2. **Relay and Corliss: pin the form of the sync resource URL.** Proposed:
   `https://sync.<cluster_domain>`, no trailing slash. The plugin sends it as
   `resource`, Corliss issues it as `aud`, the relay expects it as
   `SYNC_AUDIENCE`, and the socket uses the same host over `wss`.
3. **Done.** **Relay: the document schema**, D6 above.
4. **Done.** **Relay: `GET /vaults` response shape.** The relay answers
   `{"vaults": [...]}`; see V1.
5. **Corliss: the Notes page shows the sync URL in the form in 2.**

## Test plan

### Unit tests, in this repo

- `schema`: name rules, NFC, the collision test, the conflict name.
- Outbound: an edit with no remote change; an edit merged with a remote
  change made since the base; a remote change is not reverted by a local
  edit elsewhere in the note; a save with no change does nothing.
- Inbound: a remote change is written and recorded; a pending local edit is
  merged first; a burst produces one write.
- Echo: the plugin's own write causes no outbound change.
- Structure: rename in place; move with add before remove; a move seen half
  done; an interrupted move finished at startup; local and remote delete;
  duplicate paths renamed the same way from two sides; a delete against an
  unsent edit restores the entry.
- Reconciliation: each row of O6; the vanished-vault guard.
- Connect: each row of V3; nothing is overwritten without a copy.
- Auth: PKCE challenge, state mismatch, refresh single-flight, a lost
  response retried with the same token, `invalid_grant` signs out.

Two in-memory repos joined directly stand in for the plugin and the relay.

### Against the deployed relay, on the laptop

| Check | How |
|---|---|
| 1. Sign in, pick a vault, a note round-trips | Two Obsidian vaults on one laptop connected to one relay vault |
| 2. Concurrent edits to one note merge | Edit both sides while one is offline |
| 3. A Claude edit through MCP appears in Obsidian, and the reverse | Relay acceptance check 5 |
| 4. An edit in another editor is picked up | Edit the file in a text editor with Obsidian running, and with it closed |
| 5. Typing in a note while a remote edit arrives keeps the cursor and every keystroke | O5. Decides whether the fallback is needed. Passed 2026-10-26 on 1.0.2: the fallback is not needed. |
| 6. A move made in Finder | Records whether Obsidian reports `rename` or `delete` plus `create` |
| 7. 500 notes dropped in at once | All arrive; no duplicate documents |
| 8. The connection survives token expiry | Run past 15 minutes; no gap in sync |
| 9. Swapping the WebSocket adapter on a live repo | N1 |
| 10. `doc-unavailable` for a document held locally | Point a vault at a document the member may not open. Record what 2.5.6 does. Answers relay open question 2. Skipped. |
| 11. Reconnect cost | Read the per-connection log on a vault of real size. Feeds relay open question 7. Not run. The measure was removed before the listing; Obsidian asks that the console carry only errors. |
| 12. A removed member | Refresh fails, status says signed out, files stay. Skipped. |
| 13. A lost store | Delete the IndexedDB database, restart; V3 runs and nothing is duplicated |

### On a real iPhone

Already settled by the probe, 2026-10-08: BRAT install, `onUserEnable`, the
sign-in return with Obsidian alive and closed, `window.open`, `requestUrl`
against `fetch`, the socket dying in the background, `persist()` refused,
`SecretStorage`, WASM start time.

Run on 0.2.1 and 0.2.2 through BRAT, recorded 2026-10-26:

| Check | How | Result |
|---|---|---|
| 14. Checks 1, 2 and 3 on the phone | Corliss acceptance check 4, relay acceptance checks 4 and 5 | Passed. A note round-trips laptop and phone. Edits made while the phone was offline merged with nothing lost or doubled; two concurrent inserts at the same point land in Automerge's order, not typing order. A Claude `append_note` reached the phone, and a phone edit read back over MCP. |
| 15. Leave and return | Edit on the laptop while the phone is away; the change is there within seconds of returning | Passed, for an edit made while the phone was locked and one made while Obsidian was killed. |
| 16. Startup time with a real vault | Time from launch to "Up to date" | Passed by eye: quick on a three-note vault. Not timed against a large vault. |
| 17. IndexedDB over days | The probe's storage test, repeated | Passed. The IndexedDB and local storage markers survived 18 days with `persist()` refused. |
| 18. A refresh interrupted by backgrounding | Corliss open question 2. Background the app at the moment of refresh, return after 10 seconds and after 2 minutes. | Skipped by choice. Corliss open question 2 stays open. |
| 19. Sync TLS | The sync host's certificate is trusted by the phone with no profile installed | Passed. |

### Release check, 1.0.2

1.0.2 changed how sync messages are decoded (cbor-x's no-eval build) and the
uuid that names new documents (11.1.1). Run 2026-10-26 on the laptop through
BRAT against production:

- The update reached Up to date.
- An edit typed in Obsidian reached the relay, and an MCP append reached
  Obsidian while typing went on (check 5).
- A new note created in Obsidian: confirmed by Jacob in Obsidian. The note
  was not seen on the relay over MCP.

## Open questions

1. **The issuer.** Answered: the relay serves the metadata on the sync
   listener (request 1), so the member pastes one URL.
2. **The open-editor path.** Answered: check 5 passed, so O5 stands and
   the fallback is not needed.
3. **Delete against a concurrent edit.** T5 is a heuristic. A better rule
   needs the relay to say what it holds for a document.
4. **A move whose mover never returns.** The note stays at two paths on the
   relay and at the old path on other devices. No device but the mover
   removes the old entry. Decide whether another device may, after a
   timeout.
5. **Clearing a secret.** `SecretStorage` has no delete call in the types.
   Confirm that writing an empty value is accepted, or keep a "signed out"
   marker in `data.json`.
6. **A size limit for one note.** 2 MB is a guess. Automerge text of that
   size has not been measured here.
7. **Community directory.** Answered: members install from it; see
   "Distribution" and issue #1.
8. **Switching vaults.** Disconnect then connect works. Whether the local
   files of the old vault should be moved aside is not decided.
9. **Bulk import.** Out of scope. V3's adopt-or-copy rule is most of what it
   would need.

## Rollout

1. Agree the requests to the other specs and copy D6 into the relay spec.
2. Build in the order: schema and state; the repo and connection; auth;
   connect (V3); outbound and inbound; structure changes; reconciliation;
   UI.
3. Laptop checks 1 to 13 against the deployed relay. Done, except 7,
   skipped on purpose (scn-sync-relay#1); 10 and 12, skipped; and 11, not
   run.
4. Development releases through BRAT. iPhone checks 14 to 19. Done, with 18
   skipped.
5. Submit to the community directory (issue #1). Members are pointed at the
   plugin only once it is listed.
6. Retire `probe/` once check 17 has run long enough to answer it. Done.
