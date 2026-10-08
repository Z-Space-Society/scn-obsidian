# SCN Sync Probe

A throwaway Obsidian plugin. It runs the checks that SCN Sync's design
depends on and that need a real iPhone. It syncs nothing, talks to no SCN
service, and touches no notes.

Use it in a scratch vault. It registers the `obsidian://scn-obsidian` action,
the same one SCN Sync will use, so disable it before installing SCN Sync.

## What it contacts

- `httpbin.org`, for a page that redirects back to Obsidian.
- `example.com`, for one test request.
- `echo.websocket.org`, a public echo server, for the socket test.

The redirect and socket addresses can be changed in the probe's settings. A random test
value is sent to them and nothing else.

## Install on the iPhone

1. In Obsidian, create a new vault for testing. Leave **Store in iCloud**
   off.
2. Settings, Community plugins, turn on community plugins.
3. Browse, install **BRAT**, enable it.
4. In BRAT's settings choose **Add beta plugin** and enter
   `Z-Space-Society/scn-obsidian`.
5. Enable **SCN Sync Probe**. A notice saying `onUserEnable fired` is the
   first result.
6. Open Settings, then **SCN Sync Probe**.

Installing this way is itself one of the tests. Note anything that goes
wrong.

Requires Obsidian 1.11.4 or later.

## The tests

Every result lands in the report at the bottom of the settings screen.
**Copy report** copies it as JSON.

### 1. Storage

- **Storage durability.** Run it once to write markers. Run it again after
  restarting Obsidian, after a few days, and after the phone has been short
  of space. `LOST` means iOS removed the data.
- **Secret storage.** Run it once to write a throwaway secret, and again
  after a restart. It also reports whether the secret sits in the webview's
  ordinary local storage.

### 2. Sign-in return

Each of these should end with a notice in Obsidian saying
`callback received, state matched`.

- **A. Open the browser from code.** Tap **Open**. Safari should open and
  hand straight back to Obsidian.
- **B. Open the browser from a link.** Tap **Make link**, then tap the link.
  Use this if A does nothing.
- **C. Return to a closed Obsidian.** Tap **Copy address**. Swipe Obsidian
  away in the app switcher. Paste the address into Safari. Obsidian should
  start and show the notice.

Note whether Safari asked "Open in Obsidian?" each time.

### 3. Network

- **fetch against requestUrl.** One tap.
- **Socket across backgrounding.** Tap **Connect**. Then, one at a time:
  switch to another app for 10 seconds and come back; again for 1 minute;
  again for 5 minutes; lock the screen for 1 minute. The log records what
  the socket did each time. `ALIVE` or `DEAD` after each return is the
  answer.

### 4. Automerge

- **WASM load time.** Restart Obsidian first, then run it once. `initMs` on
  that first run is the number that matters.

## Also worth one run on the laptop

The same build installs on desktop through BRAT. The storage, secret and
sign-in return results there are the comparison.

## Build

```
cd probe
npm install
npm run build
```

This writes `probe/main.js`. A release carries `main.js` and
`manifest.json` from this folder as assets, and the release tag must equal
the `version` in `manifest.json`.
