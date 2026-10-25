# Example: Counter

A minimal third-party widget that exercises the whole install path:

- Installing from disk (drag the folder into the window)
- Loading HTML / CSS / JS over the `lattice-widget` protocol
- Receiving theme tokens (`--surface`, `--fg`, …)
- Requesting the `storage` permission and reading/writing private storage

## Try it

Drag this **folder** (not the files inside it) from Explorer into a Lattice window. The widget library confirms the install; then click the "Counter" card to place it on the canvas. The card asks for the **Storage** permission as soon as it loads — it reads the saved count before painting its first frame — so approve it once and the count survives a restart.

## Layout

```
counter/
  manifest.json   id, entry, icon, size, requested permissions
  index.html      markup; only relative asset paths
  icon.svg        shape only — the platform masks it and paints it with the current text colour
  style.css       colours come from --surface / --fg style variables, so it follows the theme
  widget.js       bridge client + business logic; imports ./lattice.js
  lattice.js      a copy of packages/sdk/lattice.js — keep it next to widget.js
  lattice.d.ts    types for editors; not loaded at runtime
  README.md       this file
```

## What to change

- `manifest.json`: `id` must be your own (lowercase letters, digits, `.` and `-` only) and
  must match the folder name, or installs get mixed up.
- To read other data, extend `permissions` and call `lattice.call("<method>", params)` from
  `widget.js`. The method table is in `docs/WIDGET_SPEC.md` §4.
- Never hard-code colours. The platform pushes the current `--lattice-*` values with a
  `theme` message and the SDK writes them onto CSS variables (`--fg`, `--surface`, …)
  automatically; `style.css` only ever reads those.
