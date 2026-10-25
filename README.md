<div align="center">

<h1>棂 · Lattice</h1>

<p><strong>Your own widgets on the Windows desktop — a widget is just a web page.</strong><br>
Whoever writes one writes HTML / CSS / JS; real windows, the sandbox, permissions, install and update are the platform's job.<br>
No account, no server.</p>

<p>
<a href="https://github.com/unraveltao/lattice/actions/workflows/ci.yml"><img src="https://github.com/unraveltao/lattice/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="MIT license"></a>
<a href="#install-and-build"><img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4.svg" alt="Windows 10 / 11"></a>
</p>

<p>English · <a href="./README.zh-CN.md">中文</a></p>

<p><a href="docs/screenshot-desktop.png"><img src="docs/screenshot-desktop.png" width="900" alt="Three widgets on a plain desktop: clock, to-do list and bookmarks"></a></p>

<p><sub>Three of the official widgets — clock, to-do and bookmarks — captured from a running build<br>
at 2× and placed on a plain wallpaper. Nothing from a real desktop is in the frame.</sub></p>

</div>

---

## What it is

**Lattice is a widget platform for the Windows desktop. The little things sitting on your desktop — a clock, a to-do list, system stats, whatever is playing — are each a widget, and they are not pictures. They are real windows.**

Those windows have no frame, stay out of the taskbar, and do not steal focus from whatever you are typing into. They can be pinned above everything else, or tucked under ordinary windows against the wallpaper. Position is remembered per monitor, so a mix of display scalings will not fling a card off the edge; data lives on disk and everything is back where it was after a restart.

The difference from other desktop toys: **widgets are not built in, they are installed.** The 17 official widgets go through the same install path as any third-party one — the platform itself ships with none. So there is no ceiling on what widgets can exist: if you can write HTML, you can add one. Four files, no build step.

**It speaks Chinese and English, all the way down.** The shell switches language in settings, and so do the things you would not expect it to reach: each official widget's name, its options and its how-to text in the inspector come out of the manifest in the language you picked, and the words drawn *inside* the cards (weekdays, "2 left", Start/Pause) follow through one `language` push to every open window. No restart, no reload.

The name is 棂 (*líng*) — the wooden lattice inside a window pane, the frame every pane is set into.

## What you can do with it

| You want | Widget | What it gives you |
| --- | --- | --- |
| A glance at the time, and how long is left | Clock · Calendar · Timetable · Countdown | The current time; a month view with your own events; this week's classes with a live now line; a countdown to a date |
| Nothing slipping through | Todo · Note · Bookmarks | A list on the desktop; a scratch note that saves itself; the links you keep coming back to |
| To know what the machine is doing | System | CPU and memory with a one-minute trace, per-core load, commit charge, disk, network, uptime |
| To work for a stretch | Focus · Stopwatch | A pomodoro that is still right after you close the lid and come back; a stopwatch |
| To not lose the words you looked up | Word Drill | One card per line pasted in, four grades, and the next review scheduled in days |
| A quick sum | Calculator · Convert | Arithmetic you can copy out; two-way conversion for length / mass / temperature / data / time / speed |
| To draw it, not describe it | Diagram | Boxes, circles, diamonds and text on a canvas you can pan and zoom; arrows bend between the shapes, and the assistant can draw the whole thing from a few lines of text |
| The desktop to move with the music | Music | What is playing, skip and pause, a level that follows the sound |
| One look before you go out | Weather | Current conditions for one city, refreshed on a timer, still readable when the network is gone |
| To let a model do the clicking | `Ctrl+K` assistant + `npm run agent` | You bring the model, the key never leaves Rust; the endpoint is the same 8 allowlisted actions, the assistant adds six groups of hands you switch on one at a time, and the CLI shows you what they did |
| None of the above | Write one | See [Writing a widget](#writing-a-widget) |

## What it is not

- **Not a skin engine.** No DSL, no skin format to learn: a widget is a web page, so the CSS you already know just works.
- **Not the widget panel Windows ships with.** That one only Microsoft and its partners can publish to; here you write your own and drop the folder in.
- **Not one Chromium per widget.** Every widget shares the system WebView2, so a dozen widgets is not a dozen browsers.

## Two ways to use it

**Just want to use it** → grab the [installer](#install-and-build), pick a few from the library, drag them onto the canvas, hit **Send to desktop**. They stay there across restarts.

**Want to write one** → see [Writing a widget](#writing-a-widget). One folder, four files, no build step; dropping the folder into the window is the install.

## How it works

The important part is that a widget *becomes a window* while never touching Windows. It runs in a sandboxed iframe with `sandbox="allow-scripts allow-forms"`, an opaque origin and a CSP that pins it to its own files, and every capability it has is a request over one message bridge — `clock` for the time, `storage` for its own little database, `network` for an allowlist of hosts you can read, and so on. There are twelve permissions in total. Nothing is granted by default, and installing a widget does not grant it anything: you approve each capability once per widget, and revoking one takes effect in the windows that are already open.

**The platform ships empty.** The 17 official widgets are ordinary packages that you install from the library like any third-party one — they are not compiled into the app, and nothing is auto-installed. That is the difference between an extension platform and a desktop toy, and it is invariant #1 in [AGENTS.md](./AGENTS.md).

So is the absence of a server. The catalogue is a static `registry.json`, the packages are signed files, the hosting is GitHub Pages, and updates are a release asset. When a design starts to need a backend, the design is wrong — that constraint is argued out in [docs/ROADMAP.md](./docs/ROADMAP.md), not assumed.

**What that costs.** Those three decisions are the ones that make Lattice look odd next to a desktop toy, and none of them is free:

- *Shipping empty* means the first run is an empty desktop and a library you have to fill yourself. The alternative — six widgets pre-installed — reads better in a screenshot and kills the extension model on day one.
- *No server* means the catalogue is a file someone re-publishes by hand, ratings never aggregate into a number, and reporting a bad widget is a file you send the author yourself. A backend would fix all three, and would also make the project need an operator.
- *One bridge* means a widget cannot do the obvious thing: no `localStorage`, no `fetch`, no reading the page it sits in, no direct Win32. Every capability is a bridge method with a permission you grant once per widget. That is why the API is small — and why it has to be enough, since the official widgets use nothing else.

The reasoning behind each, including what was tried and dropped, is in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/ROADMAP.md](./docs/ROADMAP.md) — both in Chinese, because that is the language the people who change this code read.

## Where it stands

**v0.12 is the current milestone.** The `v0.x` numbers in this README are milestone labels, not release versions: what the installer reports is `0.1.1`, and that is the only number that ships. v0.11 is still open on three gaps, and v0.13 is a design doc for putting the assistant on the desktop — not code yet.

The milestones behind it: v0.8 let an agent drive the desktop (an opt-in loopback endpoint, 8 allowlisted actions, every call in an audit log); v0.9 added sound you can see and links that get out; v0.10 brought the built-in assistant — **a model you bring, hands that stay ours**: `Ctrl+K` opens a small window, paste an OpenAI-compatible base URL and a key once, and the key lives in `assistant.json` under Rust's control while the frontend only ever sees `sk-1…cdef`. At that point the only thing the model could *do* was the same eight allowlisted actions the agent endpoint already had, and a widget asking for `llm:chat` got text back, never tools.

v0.11 is where the hands arrived: six groups it can switch on one at a time — read files, run commands, fetch pages, look at windows, click and type, and call tools declared by the MCP servers you add. All six are off by default, reads go through without a prompt, writes and commands and clicks ask first, and the audit line records the shape of a call but never its contents. The same milestone let a widget *borrow* those hands: `desktop:control` runs one assistant turn for a pet, on a narrowed tool table with removal cut out.

v0.12 turned that pile of switches into **two modes** — *internal*, the desktop actions plus the tools widgets declare plus whichever hands you have opened, and *full access*, all six with no prompts behind a confirmation you have to tick — and added skill packs: `skills/<id>/SKILL.md` text in the prompt, documentation rather than permission.

How each version was argued out is in [ROADMAP](./docs/ROADMAP.md).

| Version | What it added |
| --- | --- |
| **v0.1** | The skeleton: Tauri + React shell, canvas, sandboxed iframes, the bridge |
| **v0.2** | A real desktop: `desktop` / `top` layers, per-placement windows, chrome, data on disk |
| **v0.3** | Platform behaviour: tray, start with Windows, pause-all, live reload, crash recovery, occlusion, DPI clamping, snap guides on the canvas *and* the desktop |
| **v0.4** | Author experience: `@lattice/sdk`, `create:widget`, `pack:widget`, SMTC media, the `Ctrl+Shift+D` debug drawer |
| **v0.5** | Distribution: static catalogue, three signature checks, update + rollback, local ratings and reports, permission re-review |
| **v0.6** | The catalogue goes public on GitHub Pages, with a disk cache, `If-None-Match`, and an honest offline fallback |
| **v0.7** | Delivery: NSIS installer, in-app updater, draft-first releases, and the SmartScreen problem written down instead of hidden |
| **v0.8** | Agent access: an opt-in loopback HTTP endpoint, a token, an audit log, 8 allowlisted actions, and an activity board widget |
| **v0.9** | `lattice.music`, `audio:level`, `lattice.bookmarks`, `shell:open` |
| **v0.10** | The built-in assistant: your own model behind an OpenAI-compatible URL, the key kept in Rust, tool calling over the same 8 actions, `llm:chat` for widgets, and `desktop:control` so a widget can borrow those hands. The Agent-board widget was dropped in this version |
| **v0.11** | Hands: six groups of capabilities (files, commands, web, screen, mouse and keyboard, MCP servers), three approval modes, model profiles, sessions on disk, and `agent:tools` so a widget can declare tools of its own |
| **v0.12** | Skill packs and the workspace exemption zone; two modes — internal / full access |

**By the numbers**

| Metric | Value |
| --- | --- |
| Official widgets | 17 |
| Permissions | 12 |
| Tauri commands | 92 |
| Browser assertions | 2 442 over 52 pages |
| Rust tests | 415 |
| Documented pitfalls | 84 |

Every one of those is enforced by something. The browser assertions run a real dev server and a real Chrome in CI; the Rust tests split 364 `rustc --test` pure-logic cases plus 51 that need a full `cargo test`; the pitfalls are the ones that actually bit, each with the reasoning that prevents a relapse.

## Two hosts, one bridge

The same widget appears in two places, and the platform refuses to let them drift:

- On the canvas it is an iframe inside the main window (`WidgetFrame.tsx`). On the desktop it is a `WebviewWindow` loading `widget-host.html`, which hosts the *same kind* of sandboxed iframe. Both call the same bridge handler with the same method table and the same permission gates, so there is no "works in preview, breaks on the desktop" fork — that fork is a bug, not a feature.
- Authorization is by **window reference**, not origin: sandboxed documents all have the origin `"null"`, so `event.source === iframe.contentWindow` is the only thing that distinguishes one instance from another.
- Permissions are granted per `widgetId` ("do you trust this code?"), configuration is per `instanceId` ("how should *this* copy look?"). Two clocks can show 12 and 24 hour time; you still approve the widget once.
- Both hosts render the first frame from defaults and *then* ask the bridge. A slow host is a three-second blank card otherwise — the most common way a widget looks broken without being broken.

<p align="center"><a href="docs/screenshot-editor.png"><img src="docs/screenshot-editor.png" width="900" alt="The main window: widget library, canvas and inspector"></a></p>

<p align="center"><sub>The main window: library on the left, canvas in the middle, inspector on the right, with the clock selected. Canvas previews are an approximation — there is no wallpaper to sample inside a window, so the backplate there is a computed blend.</sub></p>

## The desktop is a surface, not a preview

<p align="center"><a href="docs/screenshot-chrome.png"><img src="docs/screenshot-chrome.png" width="330" alt="A desktop widget with its window chrome"></a></p>

<p align="center"><sub>A clock on the desktop with the chrome revealed: drag, layer, pin, reload, close — drawn by the host page, never by the widget.</sub></p>

- **Layers.** `layer: desktop` windows are parented to WorkerW and sit below normal windows; `layer: top` windows use `HWND_TOPMOST`. Both are frameless, absent from the taskbar, and use `WS_EX_NOACTIVATE` so clicking one never steals focus from what you were typing in. Corners are clipped with `SetWindowRgn`, matching the canvas radius.
- **Chrome that does not steal the card.** The pill reserves 120 px in the top-right corner, it fades in on hover, and every official widget spends that budget in its CSS — the card size in a manifest is a budget, not a design canvas.
- **Snap guides, in both places.** Dragging a widget snaps it to its neighbours and to the container edges, one winner per axis. The guide is drawn as a local dashed segment centred on the dragged card, reaching half a card plus 48 px in each direction — no full-screen crosshair. On the desktop those lines are two 1 px layered windows with per-pixel alpha on their own message thread, *not* a transparent WebView2 window, which cannot be created on software-rendered machines.
- **Invisible means stopped.** Heartbeats live on one schedule; when a window is hidden the whole timeline stops and catches up with a single tick on return. "Hidden" has two sources on purpose: `document.visibilityState` is useless here — a minimised window still reports `visible` — so Rust observes it and pushes `lattice:window-visible`. A third source covers the case nobody notices: every 1.5 s nine points inside the window are asked `WindowFromPoint`, and if all nine land on somebody else's window, a maximised browser counts as hiding your widget.
- **It stays where you put it.** Positions are clamped to the monitor the widget is on, in physical pixels end to end, so mixed-DPI setups do not lose cards off-screen or shrink them by half.

## Backplate: the platform owns the surface

<p align="center"><a href="docs/screenshot-backplate.png"><img src="docs/screenshot-backplate.png" width="860" alt="The same clock in three backplates"></a></p>

<p align="center"><sub>The same clock three ways: <code>auto</code>, a solid light tint, and 35% fill with blur over the wallpaper. Colour, fill and blur are per-instance sliders in the inspector.</sub></p>

The widget's own CSS never sees the wallpaper. The host window paints three layers behind the iframe — a screenshot of the wallpaper, blurred; a veil tinted from the theme; the widget — and adapts the contrast. Widgets therefore only ever use tokens (`--lattice-text`, `--lattice-accent`, `--lattice-border`), never hard-coded colours, because the platform flips them wholesale when the surface turns light. Under the factory setting (`auto`) it overrides nothing: the default look is pixel-identical to the feature not existing.

That trade has a visible cost, and it is written down rather than papered over: the blur is the *wallpaper*, not the windows behind the widget, because the system's blur radius is fixed. You can have a continuous slider or a real see-through pane, not both.

## One widget, many copies: per-instance options

<p align="center"><a href="docs/screenshot-inspector.png"><img src="docs/screenshot-inspector.png" width="380" alt="The inspector with one card selected"></a></p>

<p align="center"><sub>The inspector with one card selected: layer, click-through, backplate, size, the widget's own options, and its permissions.</sub></p>

A widget declares its options in its manifest — `toggle`, `number`, `text`, `select`, `date` — and the platform renders them in the inspector, per instance. The widget never draws its own settings UI: a card is a few hundred pixels wide at most, and preferences saved per widget would be shared by every copy of it. Missing values fall back to the declared defaults, and illegal values are rejected, in exactly one place (`resolveConfig`), so the canvas and the desktop cannot disagree. Changing a config value pushes `config-changed` and does **not** reload the widget; only a permission change reloads, because a widget that was denied a capability may have written "permission denied" into its own DOM and has to start over.

## When a widget breaks

Errors are a separate channel from the bridge, deliberately. `__lattice_diag` and `__lattice` are two different messages; both hosts check for an error report before a bridge request, and the report is validated structurally *after* the source check — otherwise a widget could forge an error to win a reply from the host. A missing entry file comes back as a readable page instead of a blank body: `File not found` with the widget id, the path it asked for, the folder that was searched, and the line in `manifest.json` to fix. A renderer crash reloads itself up to three times in a minute, then stops trying and offers a **Try again** bar instead of spinning forever. Saving a widget's files reloads it in place (300 ms of silence, debounced, capped at 2 s, suppressed during installs), so editing CSS does not mean deleting the card and dragging it back.

## The sandbox boundary

Every capability is a permission, and every permission is a gate in `runtime/bridge.ts` before a single byte reaches Rust.

| Permission | What it unlocks | Asked for by |
| --- | --- | --- |
| `clock` | The system clock, as an absolute instant | Clock, Countdown |
| `storage` | A private key-value file, `widget-data/<widgetId>.json` | 12 of the 17 |
| `clipboard:write` | Put text on the clipboard | Calculator |
| `network` | HTTP requests to the hosts listed in the manifest | Weather |
| `system:monitor` | CPU, memory, disk, network, uptime | System monitor |
| `media:control` | Read and drive the Windows media session (SMTC) | Music |
| `audio:level` | One number in `0..1`: how loud the output is | Music |
| `shell:open` | Hand an http/https URL to the default browser | Bookmarks |
| `agent:activity` | Read the agent's audit log | Nothing built in — third-party only |
| `llm:chat` | Send a conversation to the assistant's model, get text back | Desktop pet |
| `agent:tools` | Declare the widget's own capabilities as tools the assistant can call | Diagram |
| `desktop:control` | Borrow the assistant's hands for one turn — rearrange widgets, never remove them | Desktop pet |

<p align="center"><a href="docs/screenshot-permission.png"><img src="docs/screenshot-permission.png" width="380" alt="A card asking for a permission it was not granted"></a></p>

<p align="center"><sub>A widget that reaches for a capability it was not granted says so on the card, by name; one <code>Grant</code> covers the set, and the widget re-initialises.</sub></p>

Six of those deserve their own paragraph, because "it has the permission" is never the whole story.

**`network` is an allowlist, not a switch.** A request passes three gates in a fixed order: the permission exists → the target host is listed in `manifest.network.hosts` → the request shape is legal (method, header count, body size). There are no wildcards, on purpose: `*.example.com` turns "I allowed this one endpoint" into "I allowed the whole domain", and the permission panel only shows one line — the user could not review what they approved. A port is part of the host's identity, and redirects are never followed: following a 302 from an allowed host to an unfriendly one would hand the allowlist to whoever controls the first hop. Requests travel over IPC rather than a local HTTP proxy, because a proxy port would be a second, unaudited way out.

**`shell:open` opens exactly one kind of door.** `tauri-plugin-opener` passes the string straight to `ShellExecuteW`, which does *not* validate schemes — `file:` would hand a local file to its default program, `ms-settings:` would jump to a Windows privacy page. So the protocol allowlist (`http` / `https` only) lives in `open_policy.rs`, in front of the plugin, and the widget's own normalisation of what the user typed is a second, independent check. It does not weaken the navigation block: a widget's document still cannot navigate itself away to smuggle data into a URL.

**`audio:level` is one number.** A background thread captures the default output device with WASAPI loopback and computes RMS → decibels → a `0..1` envelope with a release curve. The command only reads the latest value. No buffer, no audio content, nothing to reconstruct — the only version of "show me the sound" that is safe to ship.

**`llm:chat` is a mouth, not hands.** A widget can hold a conversation with the model you configured, and that is all: the bridge calls `llm.chat` with `tools: null` every time, and a reply that asks for a tool call comes back as an `internal` error instead of being executed. The key never enters the renderer — Rust reads it, attaches it, and returns text plus a masked hint — so a compromised widget has nothing to steal and nothing to move. Changing the desktop stays with the platform's own assistant, which is the thing *you* are talking to.

**`agent:tools` is the one permission where the widget talks to the model first.** A widget declares tools in its manifest and they surface to the assistant as `widget.<id>.<tool>` — one entry however many copies are placed, and the copy that answers is the one on the canvas. A reply longer than 4 000 characters is rejected rather than truncated, on the same principle as `say`.

**A widget can borrow hands, never grow its own.** `desktop:control` → `assistant.ask` runs one assistant turn on a widget's behalf: the same loop, the same executor, the same audit log, but a tool table with `placement.remove` cut out — a misunderstood sentence can never delete a widget you placed. The loop itself still runs in the main window (the desktop host does not even have the store), and the widget gets back only a sentence and a list of what actually happened. One turn at a time, and the timeout is 180 seconds, because six model round-trips do not fit in eight.

## Distribution without a server

```bash
npm run store:index                               # pack + sign every widget, write the catalogue
npm run sign:widget -- --gen-key --out my.key     # your own publisher key
```

The catalogue is a JSON index. The packages are `.lattice` files — deterministic zips. Installing one runs three checks in this order:

1. The SHA-256 of the bytes matches the digest in the catalogue.
2. The ed25519 signature verifies against `publisher.key`.
3. That key equals **the one pinned locally the first time this widget was installed**.

The first two catch corruption and forgery. Only the third catches "generate a new key and swap the catalogue too", which is why a key change needs an explicit nod with both fingerprints on screen. The catalogue itself is unsigned — it is an index, and it must stay incapable of driving behaviour.

Updates copy the old version into a single backup slot first, and the card grows a `Back to x.y.z`. Rolling back **swaps** the two directories rather than copying, so the button works in both directions instead of getting stuck after two presses. Ratings and reports are local files: with no server there is no "submitted", so the dialog tells you where the file is and you send it to the author yourself. A new version that asks for more permissions gets neither a silent yes nor a disabled widget — it keeps working, with a banner that does not auto-dismiss until you answer it.

The same three ideas carry the default source: `registry.json` on GitHub Pages, fetched with `If-None-Match`, cached to disk, and — when the network is gone — served from the last good copy with a line saying how old it is ("Showing the catalogue from 3 hours ago"). The copy bundled with the app is only the last resort, and the UI says so when it is in use, because its packages are signed with a different key.

## Agent access

[docs/AGENT_ACCESS.md](./docs/AGENT_ACCESS.md) has the threat model; this is the shape of it.

The endpoint is **off by default**. When you switch it on, Lattice binds an HTTP server to `127.0.0.1` on a system-assigned port, writes `endpoint.json` (address plus a token) into `%APPDATA%\com.iron-tom.lattice\agent\`, and deletes that file on exit. Requests need the bearer token, compared in constant time, and every call lands in an audit log — including the rejected ones.

Eight actions are allowlisted, and the list is a test: `placement.add`, `placement.move`, `placement.resize`, `placement.remove`, `placement.pin`, `placement.front`, `theme.set`, `widgets.pause`. Plus `say`, which is not an action but a line of voice: 500 characters, single line, **rejected rather than truncated** when it does not fit.

```bash
npm run agent -- ping
npm run agent -- state
npm run agent -- say "focus mode for the next hour"
npm run agent -- act theme.set --args '{"theme":"dark"}'
npm run agent -- act placement.add --args '{"widgetId":"lattice.clock"}'
```

The client is a couple hundred lines of zero-dependency Node: it reads that endpoint file and nothing else. `npm run agent -- state` prints what the agent can see, `-- act …` makes it do something, `-- say "…"` leaves a note in the log — you can watch what the machine did on your behalf without opening a terminal, and without a widget sitting on your desktop.

**Two modes, not a countdown.** The assistant is the same executor wearing one of two personalities. *Internal* is the desktop: move widgets, set the theme, call the tools widgets declare, plus whatever hand groups you have opened — it has no business reading arbitrary files off `C:\`. *Full access* is everything: all six groups on, no prompts, behind a confirmation that spells out what it can now do and makes you tick that you understand. The mode is a persisted switch rather than a timed grant, because a half-hour grant answers "I forgot to turn it off" by interrupting a long job every half hour; what replaces the interruption is a marker that stays visible and an audit log that fails closed.

**Skills are documentation, not permission.** A skill is a folder with a `SKILL.md` in it: text injected into the prompt, capped at 8 000 characters, switched on one skill at a time. It tells the model how you want something done and grants it nothing. The workspace is the mirror image — it stopped being a default path and became an exemption zone, and that exemption covers `file.write` only: running a command from inside it still asks.

## Writing a widget

Four files and no build step:

```
demo.mine/
  manifest.json    id (reverse-domain), version (semver), permissions, size, config, help
  index.html       entry point, transparent background
  widget.js        your code — the SDK is a copied file, not an npm install
  style.css        tokens only, no hard-coded colours
```

```js
import { createLattice } from "./lattice.js";

const lattice = createLattice();

// First paint from defaults. Never wait for the bridge before drawing.
render({ text: "New note", size: 16 });

const note = await lattice.storage.get("note");
if (note) render(note);

lattice.storage.onChange(async () => render(await lattice.storage.get("note")));
lattice.on("theme", () => render());   // tokens are already applied to :root
```

Three habits the platform will punish you for skipping:

- **Use `schedule.every`, never `setInterval`.** A raw timer keeps ticking while the widget is invisible, which defeats the whole pause story, and the schedule is the only thing that knows about visibility.
- **Respect the chrome budget.** The pill floats over your content and is clickable. Reserve `padding-right: 120px` (or a 24 px status strip) or your first line goes under the close button.
- **Declare your options in the manifest.** The inspector renders them per instance; a settings UI drawn inside the card is a settings UI nobody can use.

```bash
npm run create:widget -- demo.mine    # scaffold, already chrome-aware
npm run pack:widget -- demo.mine      # folder → .lattice, drag straight into the window
```

[`examples/counter`](./examples/counter) is the reference implementation. [docs/WIDGET_SPEC.md](./docs/WIDGET_SPEC.md) is the contract: the full method table, the config field types, the manifest rules, and the traps that only show up once a widget is real — native form controls, a transparent background, the space the chrome eats. The SDK source and its one-page manual live in [`packages/sdk`](./packages/sdk); `examples/counter` carries a copy as `lattice.js` beside its own code, kept in sync by `npm run sdk:sync` and checked by `npm run test:sdk`. The official widgets deliberately do not use it — they are the proof that a widget needs nothing but the bridge.

## Install and build

**To just install it, no compiling.** Take the Windows installer (`*-setup.exe`) from [Releases](https://github.com/unraveltao/lattice/releases) and run it.

The first launch gets stopped by SmartScreen as an "unknown publisher" — the installer is not code-signed yet, so click **More info → Run anyway**. That is a procurement problem, not a technical one, and it sits in the known-gaps table in [AGENTS.md](./AGENTS.md) rather than being quietly ignored.

What follows is for people changing the code.

A build needs Node 20.19+ (or 22.12+), Rust (the `windows-gnu` toolchain) and the WebView2 runtime — all standard [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run dev          # front end only, http://localhost:1420 — everything but "send to desktop"
npm run tauri:dev    # the real app
npm run tauri:build  # NSIS installer + updater artifacts
```

Use the wrapper scripts, not `npx tauri`: `scripts/tauri.mjs` puts the bundled `mingw64` and the `gcc` shim on `PATH`, and compiling around it fails in `resource.rc` instead of telling you why.

The checks, in the order CI runs them:

```bash
npm run typecheck        # tsc --noEmit
npm run test:injection   # the diagnostics reporter is injected identically on both paths
npm run test:sdk         # every embedded SDK copy matches packages/sdk
npm run test:agent       # the agent client's request shape and exit codes
npm run test:tokens      # the three scales' rules themselves (half-pixels, exemptions, font shorthand)
npm run check:tokens     # the repo actually obeys them: sizes, radii, 2 px spacing grid
npm run test:browser     # 2 442 assertions over 52 pages, real Chrome, real dev server
```

The browser suite is the interesting one. Each `tests/*.html` page is a real assertion page — pure logic (semver, config, catalogue, guides, close guard, screen fit), layout budgets, and widget behaviour — served by the dev server and driven by Chrome. It exists because "it works on my machine" was, repeatedly, wrong: a sixth bookmark row measured 36 px against the 30 px its comment claimed and was silently clipped by `overflow: hidden` until somebody measured it.

Release: push a `v*` tag. Actions builds on `windows-latest`, signs the updater artifacts, appends SHA-256 sums to the notes, and creates a **draft** release — publishing by hand is what keeps a broken build from reaching everyone at once. The installer is not code-signed yet, so the first run is a SmartScreen "unknown publisher" prompt; that is a purchasing problem, not a technical one, and it sits in the known-gaps table instead of being quietly ignored.

## The repository

```
src/                 React shell, canvas, inspector, settings, store
  runtime/           manifest · config · bridge · schedule · catalogue · agent · guides (pure logic)
public/widgets/      the 17 official packages
public/store/        the bundled catalogue (generated, not committed)
packages/sdk/        @lattice/sdk — the single source of truth for the widget API
examples/counter/    a drag-and-drop sample widget
scripts/             widget index, scaffold, pack, sign, store index, agent CLI, tauri wrapper
src-tauri/src/       40+ modules, each split into a Win32 shell and a pure-logic policy with tests
tests/               browser assertion pages
docs/                architecture, widget spec, roadmap, code signing, agent access
```

**Code, roughly**

| Area | Lines |
| --- | --- |
| TypeScript | 23 030 lines |
| CSS | 6 103 lines |
| Rust | 22 854 lines |
| SDK | 801 lines |
| Widgets + example | 23 770 lines |
| Scripts | 4 853 lines |

**Read next**

| Document | What it answers |
| --- | --- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the pieces fit, and why |
| [docs/WIDGET_SPEC.md](./docs/WIDGET_SPEC.md) | The widget contract |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Where the project is, and the 9 decisions reality overturned |
| [docs/PITFALLS.md](./docs/PITFALLS.md) | Every pitfall, grouped by the symptom you are staring at |
| [docs/reference/build.md](./docs/reference/build.md) | Toolchain, build, release — the operational manual |
| [docs/AGENT_ACCESS.md](./docs/AGENT_ACCESS.md) | The agent endpoint's threat model |
| [docs/CODE_SIGNING.md](./docs/CODE_SIGNING.md) | Keys, trust anchors, what is *not* signed |
| [AGENTS.md](./AGENTS.md) | 19 invariants, written for whoever touches this next |

If you read only one thing before changing code, read the invariants in [AGENTS.md](./AGENTS.md). They are not style preferences — each one is a bug that shipped.

## License

MIT — see [LICENSE](./LICENSE).
