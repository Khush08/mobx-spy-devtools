# MobxSpy — MobX DevTools Chrome Extension

A Chrome DevTools extension that uses `mobx.spy()` to monitor and report all MobX events in your application. Designed with a **React Profiler-style UX**: start recording, interact with your app, stop, and view the results.

## Features

- **Zero-config MobX detection** via `window.__mobxGlobals.spyListeners` (MobX 6+), with fallbacks to `__MOBX_DEVTOOLS_GLOBAL_HOOK__`, `window.mobx`, and `window.__MOBX__`
- **Profiler-style workflow** — Record / Stop / Analyze, no live rendering overhead during capture
- **Grouped event display** — events grouped by name (and class for actions), with count badges
- **Interactive tree viewer** — expandable/collapsible JSON tree with color-coded values
- **Source-side filtering** — event type filters applied in the page context *before* serialization for minimal performance impact
- **Export profiling data** — download captured events as a timestamped JSON file
- **Localhost-only** — profiling is restricted to development URLs for safety
- **Dark theme** — matches Chrome DevTools aesthetic

## Supported MobX Event Types

Based on the [official MobX spy event documentation](https://mobx.js.org/analyzing-reactivity.html):

| Type | Default | Expandable | Description |
|------|---------|------------|-------------|
| `action` | On | Yes | MobX action invocations |
| `reaction` | On | No (count only) | Reaction executions |
| `scheduled-reaction` | Off | No (count only) | Reactions scheduled to run |
| `error` | Off | Yes | Errors thrown during reactions |
| `add` | Off | Yes | Observable property additions |
| `update` | Off | Yes | Observable value changes |
| `remove` | Off | Yes | Observable property removals |
| `delete` | Off | Yes | Observable map key deletions |
| `splice` | Off | Yes | Observable array splices |

Only `action` and `reaction` are enabled by default. All types can be toggled via the Filters panel. `report-end` events are unconditionally filtered out at the source — they are internal MobX bookkeeping and never reach the panel.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `mobx-devtools/` directory
5. Open DevTools on any localhost page with MobX — the **MobxSpy** tab appears

## Usage

### Recording

1. Open your app on `localhost`, `127.0.0.1`, `[::1]`, or `0.0.0.0`
2. Open Chrome DevTools and navigate to the **MobxSpy** tab
3. The idle screen shows MobX detection status (version, detection method, `__mobxGlobals` details)
4. Click **Record** to start capturing events
5. Interact with your application
6. Click **Stop** to end the session and view results

### Viewing Results

- Events are **grouped by name** — actions group by `ClassName.methodName`, others by event name
- Each group shows a **count badge** and **last seen** timestamp
- Click an expandable group to open the **detail panel** on the right
- Click individual events within the detail panel to inspect the full event data in the **tree viewer**
- Internal metadata fields (`_id`, `_timestamp`, `_objectClass`) are automatically stripped from the tree viewer — they are used internally for grouping and display only
- Use the **search bar** (`Ctrl+K` / `Cmd+K`) to filter groups by text
- Use the **Filters** button to toggle which event types are displayed

### Exporting Data

- Click the **Save** button in the toolbar (or press `Ctrl+S` / `Cmd+S`) when in the stopped state
- Downloads a `mobxspy-YYYYMMDD-HHmmss.json` file containing:
  - Session metadata (timestamp, URL, MobX detection info, enabled filters)
  - All event groups with counts and up to 50 retained individual events per group

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Focus search input |
| `Ctrl/Cmd + S` | Save/download profiling data |
| `Escape` | Close detail panel |

## Architecture

```
Page Context (inject.js)
  | window.postMessage (nonce-authenticated)
Content Script (content.js)
  | chrome.runtime.connect port
Background Service Worker (background.js)
  | chrome.runtime.connect port
DevTools Panel (panel.js)
```

### File Overview

| File | Lines | Purpose |
|------|-------|---------|
| `manifest.json` | 66 | Manifest V3 config — localhost-only URL restrictions, CSP |
| `background.js` | 135 | Service worker — message routing between content script and panel |
| `content.js` | 185 | Bridge between page context and extension, nonce auth, bfcache handling |
| `inject.js` | 613 | Page-context spy — MobX detection, event capture, serialization, batching |
| `devtools.html` | 9 | DevTools page shell |
| `devtools.js` | 11 | Registers the "MobxSpy" panel tab |
| `panel.html` | 118 | Panel markup — toolbar, filter panel, event list, detail panel, state screens |
| `panel.js` | 1314 | Panel logic — state machine, grouping, rendering, tree viewer, export |
| `panel.css` | 885 | Dark theme styles matching Chrome DevTools aesthetic |
| `icons/` | 3 files | Binoculars icons at 16, 48, 128px |

### Panel States

The panel operates as a three-state machine:

1. **Idle** — No data, not profiling. Shows MobX detection info and a prompt to start recording.
2. **Profiling** — Actively recording. Shows a pulsing red dot overlay with a live event counter. Events accumulate in memory but are not rendered live (no rendering overhead).
3. **Stopped** — Has data, not profiling. Shows the grouped event list and detail panel. The Save button becomes enabled.

**Record** always clears previous data before starting a new session. There is no separate Clear or Pause button.

### Event Pipeline

1. `inject.js` hooks into MobX via `__mobxGlobals.spyListeners` (or fallback `mobx.spy()`)
2. `report-end` events are unconditionally discarded at the source
3. Events are **filtered by type** at the source before serialization
4. Events are **serialized** via per-type field whitelists and `safeClone()` — handles proxies, circular refs, depth limits
5. Events are **batched** and flushed every 1 second (or immediately on stop)
6. Batches flow through `content.js` -> `background.js` -> `panel.js`
7. `panel.js` groups events and updates the profiling counter (no DOM rendering during capture)
8. On stop, the grouped results are rendered into the event list

### Serialization (`safeClone`)

MobX observables are Proxy objects — naive `JSON.stringify` frequently throws. The custom `safeClone()` function handles:

- Circular references (tracked via `Set`)
- Depth limiting (max 6 levels for top-level fields)
- **Per-type field whitelists** — only whitelisted fields are read from each event type, avoiding expensive Proxy traversals on unneeded properties
- **Shallow depth fields** — `arguments` and `object` start at depth offset 3 (giving them 3 levels of recursion), keeping large observable trees manageable
- **Container semantics** — Arrays and Sets do *not* consume depth levels (they are containers); only plain objects and Maps increment depth
- **Sets serialized as plain arrays** — no wrapper object, consistent rendering with array data
- Array truncation (max 100 items)
- Object key truncation (max 50 keys)
- Special types: `Map`, `Set`, `Date`, `RegExp`, `Error`, functions, symbols, bigints, `undefined`, `NaN`, `Infinity`
- Malicious Proxy traps (all property access wrapped in try/catch)
- Prototype pollution keys (`__proto__`, `constructor`, `prototype` are blocked)

#### Per-type Field Whitelists

Each event type has a whitelist controlling which fields get serialized. Fields not in the whitelist are never read from the event object:

| Type | Whitelisted Fields |
|------|-------------------|
| `action` | `name`, `object`, `arguments` |
| `add` | `name`, `object`, `observableKind`, `debugObjectName`, `newValue` |
| `remove` | `name`, `object`, `observableKind`, `debugObjectName`, `oldValue` |
| `update` | `name`, `object`, `observableKind`, `debugObjectName`, `oldValue`, `newValue` |
| `delete` | `name`, `object`, `observableKind`, `debugObjectName`, `oldValue` |
| `splice` | `name`, `object`, `observableKind`, `debugObjectName`, `removed`, `added`, `removedCount`, `addedCount` |
| `error` | `name`, `message`, `error` |
| `reaction` | `name` |
| `scheduled-reaction` | `name` |

Unknown/future event types with no whitelist entry serialize all fields.

## Security

The extension implements defense-in-depth across multiple layers:

| # | Measure | Where |
|---|---------|-------|
| 1 | Localhost-only URL restrictions in `content_scripts` and `web_accessible_resources` | `manifest.json` |
| 2 | Explicit Content Security Policy | `manifest.json` |
| 3 | Dev-URL allowlist checked before profiling starts | `panel.js`, `inject.js` |
| 4 | Nonce-based `postMessage` authentication (128-bit crypto nonce) | `content.js`, `inject.js` |
| 5 | DOM APIs only — no `innerHTML` for dynamic content | `panel.js` |
| 6 | CSS class sanitization — strips non-alphanumeric chars | `panel.js` |
| 7 | `tabId` validation via `chrome.tabs.get()` before accepting panel connections | `background.js` |
| 8 | Rate limiting — buffer caps on events (10k), groups (5k), total events (500k), pending messages (500) | `inject.js`, `panel.js`, `background.js` |
| 9 | Hardened `safeClone` — safe `instanceof`, wrapped property access, prototype pollution prevention | `inject.js` |
| 10 | `targetOrigin` set to `window.location.origin` (not `"*"`) for content->inject messages | `content.js` |

### Robustness

- **Service worker idle shutdown**: Keepalive pings every 20s during profiling prevent the MV3 service worker from going idle
- **Port disconnection**: All three scripts (content, panel, background) handle disconnects with auto-reconnect and exponential backoff
- **bfcache**: `freeze`/`resume`/`pageshow` listeners in `content.js` cleanly disconnect and reconnect ports
- **Background race condition**: Port disconnect handlers verify identity before nulling to prevent new connections from being wiped by stale disconnect events

## Memory Management

- Only the last 50 events per expandable group are retained (`MAX_EVENTS_PER_GROUP`)
- Non-expandable types (`reaction`, `scheduled-reaction`) store zero individual events
- All data is cleared on Record (new session) and on DevTools close
- Hard caps prevent unbounded growth: 5,000 groups, 500,000 total events, 10,000 per incoming batch

## Export Format

The JSON export (`mobxspy-YYYYMMDD-HHmmss.json`) has this structure:

```json
{
  "version": 1,
  "exportedAt": "2026-03-09T12:00:00.000Z",
  "url": "http://localhost:3000/",
  "totalEventCount": 1234,
  "groupCount": 42,
  "enabledTypes": ["action", "reaction"],
  "detectionInfo": {
    "detectionMethod": "__mobxGlobals",
    "version": "6.12.0",
    "spyListenersCount": 1,
    "mobxGlobals": { "version": 6, "...": "..." }
  },
  "groups": [
    {
      "key": "action:fetchData:TodoStore",
      "type": "action",
      "name": "fetchData",
      "displayName": "TodoStore.fetchData",
      "count": 15,
      "lastTimestamp": 1741521600000,
      "events": [ { "type": "action", "name": "fetchData", "_id": 1, "_timestamp": 1741521600000, "..." : "..." } ]
    }
  ]
}
```

## Requirements

- Chrome 116+ (Manifest V3 service worker support)
- MobX 4+ (MobX 6+ recommended for zero-config `__mobxGlobals` detection)
- Application running on localhost (`localhost`, `127.0.0.1`, `[::1]`, or `0.0.0.0`)

## Limitations

- **Localhost only** — intentionally blocks profiling on production URLs to prevent accidental performance overhead
- **Event retention** — only the last 50 individual events per group are kept in memory; older events are counted but not stored
- **No live rendering** — events are only displayed after stopping the profiler (by design, to avoid rendering overhead during capture)
- **Serialization depth** — nested objects are limited to 6 levels deep (3 levels for `arguments` and `object` fields); deeper structures show `[Object: max depth]`
