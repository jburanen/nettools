# NetTools — CLAUDE.md

Vanilla JS network toolkit. No build system, no framework, no npm in the frontend. All computation runs client-side. Served by nginx in Docker.

## Structure

```
html/                  # Web root (nginx bind-mount)
  index.html           # Tool card grid home page
  *.html               # One file per tool
  css/main.css         # Single stylesheet (~1400 lines)
  js/
    sidebar.js         # Shared sidebar (IIFE) — included on every page
    app.js             # Subnet calculator UI controller
    subnet.js          # Subnet pure-math library
    tcpdump.js         # tcpdump builder
    fw-monitor.js      # fw monitor builder
    fw-zdebug.js       # fw ctl zdebug builder
    compose-converter.js
    mqtt-client.js
nginx/default.conf     # CSP headers, proxy config
proxy/server.js        # Node.js WebSocket↔MQTT tunnel
docker-compose.yml
Dockerfile
deploy.ps1
server-setup.sh
```

## Adding a New Tool

1. Create `html/tool-name.html` — copy the topbar/sidebar-mount/main-content shell from an existing tool
2. Create `html/js/tool-name.js`
3. Add a nav entry to the sidebar HTML block inside `sidebar.js`
4. Add a tool card to `index.html`
5. No registration, routing, or build step needed

## HTML Page Shell

Every tool page has this structure:

```html
<div id="sidebar-mount"></div>
<main class="main-content">
  <header class="topbar">
    <div class="topbar-left">
      <button class="sidebar-toggle" id="sidebarToggle">☰</button>
      <div class="breadcrumb">
        <span class="bc-root">// category</span>
        <span class="bc-sep">/</span>
        <span class="bc-current">tool-slug</span>
      </div>
    </div>
  </header>
  <div class="tool-view" id="tool-name">
    <div class="tool-header">
      <h1 class="tool-title">...</h1>
      <p class="tool-desc">...</p>
    </div>
    <div class="tool-body">
      <!-- panels here -->
    </div>
  </div>
</main>
<script src="js/sidebar.js"></script>
<script src="js/tool-name.js"></script>
```

## Command Builder Pattern

Used by tcpdump, fw-monitor, fw-zdebug. The same structure every time:

```javascript
// 1. DOM refs at top
const $ = id => document.getElementById(id);
const inputEl = $('inputId');

// 2. Validators return { valid, value, error?, warning? }
function parseHostInput(raw) { ... }
function parsePortInput(raw) { ... }

// 3. buildCommand() — validates all fields, returns { cmd, hasErrors }
function buildCommand() {
  const r = parseHostInput(inputEl.value);
  setFieldMsg(inputEl, 'inputMsg', r);
  const hasErrors = !r.valid;
  let cmd = 'base-command';
  if (r.valid && r.value) cmd += ` arg`;
  return { cmd, hasErrors };
}

// 4. updateCommand() — rebuilds live, auto-copies after 750ms debounce
function updateCommand() {
  const { cmd, hasErrors } = buildCommand();
  cmdText.textContent = cmd;
  copyBtn.disabled = hasErrors;
  // ... debounce auto-copy
}

// 5. Wire all inputs
allInputs.forEach(el => {
  el.addEventListener('input', updateCommand);
  el.addEventListener('change', updateCommand);
});

// 6. Initial render (no auto-copy)
cmdText.textContent = buildCommand().cmd;
```

## CSS Design Tokens

Defined in `:root` at the top of `main.css`:

```
--bg-base, --bg-surface, --bg-raised, --bg-hover
--border, --border-bright
--cyan, --cyan-dim, --cyan-glow
--amber, --red, --green
--text-primary, --text-secondary, --text-muted
--sidebar-w: 240px
--topbar-h: 52px
--radius: 4px
--font: 'JetBrains Mono', monospace
```

## Key CSS Classes

**Layout**
- `.panel` — bordered section box with `panel-label` header (`// label` style)
- `.input-panel` — panel variant with more padding for form content
- `.tool-view` — max-width 960px centered content area
- `.filter-grid` — 3-column grid for src / dst / either-direction filter columns
- `.tcpdump-row` — 2-column flex pair for side-by-side inputs
- `.filter-section` — column inside filter-grid with a `filter-section-label`

**Forms**
- `.field-label` — 0.85rem label above inputs
- `.field-label-row` — flex row pairing a label with inline controls (e.g. NOT toggle)
- `.mono-input` — text input / select; full width, monospace, dark-themed
- `.input-wrap` — relative wrapper enabling overlay clear button
- `.input-clear-btn` — absolutely positioned × inside `.input-wrap`; shown via `.has-value` on wrapper
- `.field-msg` — validation message below input; add `.error` or `.warning` class
- `.input-hint` — 0.75rem muted help text; `.hint-val` inside for clickable examples

**Toggles / pills**
- `.toggle-row` — label wrapping a checkbox + toggle-label span
- `.toggle-flag` — cyan flag badge (e.g. `+`, `-k`) inside a toggle-row
- `.not-toggle` — NOT invert pill button; `.active` = cyan highlight
- `.proto-clear-btn` — inline × next to protocol select; `.active` = visible
- `.filter-reset-btn` — "reset all" text button

**Collapsibles**
- `<details class="collapsible-section">` / `<summary>` — collapsed by default (no `open` attr)
- `.collapsible-body` — padding wrapper for content inside details

**Buttons**
- `.btn-primary` — cyan filled
- `.btn-secondary` — outlined cyan

**Command output**
- `.cmd-output` — dark box with `$` prompt and `<code id="cmdText">`
- `.cmd-output.has-errors` — amber border when validation fails

## Field Validation Conventions

`setFieldMsg(inputEl, msgId, result)` drives error display:
- `result.valid === false` → adds `.error` to input, shows `⚠ error text` in msg div
- `result.warning` → shows `→ warning text` (yellow)
- Otherwise → clears msg div

The `hasErrors` flag from `buildCommand()` disables the copy button and sets `.has-errors` on the command output box.

## CIDR Handling

All tools share the same IP-to-integer bitwise approach. CIDR output differs by tool:
- **tcpdump** → BPF `net` syntax: `src net 10.0.0.0/24`
- **fw-monitor** → mask expression: `(src & 255.255.255.0) = 10.0.0.0`
- **fw-zdebug** → grep regex: `grep -E '10\.0\.0\.[0-9]+'`

Prefixes < /8 are treated as too broad and skipped in grep mode.

## fw-zdebug Specifics

Most complex tool. Key points:
- Pre-command flags (`-v`, `-k`, `-s`, `-d`, `-f`, `-e`, `-F`, `-H`) are inserted before `[+] drop`
- Grep pipeline is appended after: `fw ctl zdebug [flags] [+] drop [| grep ...] [| tee ...]`
- `withNot(flag, notEl)` — appends `v` to a grep flag when NOT is active: `''`→`-v`, `'-E'`→`'-Ev'`, `'-i'`→`'-iv'`
- `shellSingleQuote(s)` — wraps in single quotes, escapes embedded single quotes
- `parseVsIds(raw)` — validates comma-separated integers for `-v` VSX flag
- VSX, Stop/Filter, Advanced Flags, and Capture-to-file sections are collapsible (`<details>`), collapsed by default
- `allNotToggles` array drives both click wiring and reset-all cleanup

## Deployment

```powershell
.\deploy.ps1          # builds image, restarts container
```

Or manually:
```bash
docker-compose up -d --build
```

The MQTT proxy (Node.js WebSocket tunnel) runs as a second service in docker-compose, reachable at `ws://localhost:9001`.

CI/CD: `server-setup.sh` configures a GitHub webhook on the server that auto-runs deploy on push to main.

## Constraints

- **No external JS libraries** in the frontend — keep it that way
- **No build step** — all JS is plain ES6, no TypeScript, no bundling
- **CSP is strict**: `connect-src 'none'` except for MQTT ws connections — don't add fetch/XHR calls
- **Mobile support required**: test at 720px breakpoint; inputs must be ≥16px to avoid iOS auto-zoom
