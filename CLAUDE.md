# NetTools — CLAUDE.md

Vanilla JS network toolkit. No build system, no framework, no npm in the frontend. Most computation runs client-side. Served by nginx in Docker, should be behind a reverse proxy if published on the internet.

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
    routemap.js        # multi-vendor route-map builder (imports pasted route-maps, outputs a change script)
    compose-converter.js
    mqtt-client.js
nginx/default.conf     # CSP headers, proxy config, /generated/ location
proxy/server.js        # Node.js WebSocket↔MQTT tunnel
docker/                # .env theming — rendered into the container at startup
  theme.css.template   #   :root color/font/size overrides
  config.js.template   #   site title / tab title
  40-nettools-config.sh#   entrypoint script: defaults + envsubst render
.env.example           # Documented, all-optional theming vars (copy to .env)
docker-compose.yml
Dockerfile
deploy.ps1
server-setup.sh
```

## Adding a New Tool

1. Create `html/tool-name.html` — copy the topbar/sidebar-mount/main-content shell from an existing tool (this includes the `/generated/theme.css` link and `/generated/config.js` script — keep both; see Theming)
2. Create `html/js/tool-name.js`
3. Add a nav entry to the sidebar HTML block inside `sidebar.js`
4. Add a tool card to `index.html`
5. No registration, routing, or build step needed

## Versioning

Every tool shows a version next to its `<h1 class="tool-title">`:

```html
<h1 class="tool-title">Tool Name<span class="tool-version">v0.3.1</span></h1>
```

- Format is `major.minor.patch`. Stay on `0.x.y` — do not bump to `1.0.0` unless the user explicitly says a tool is production-ready.
- Bump **patch** for bug fixes or small corrections to a tool.
- Bump **minor** when a tool gains a new field, vendor target, or user-facing capability.
- **Whenever you (Claude) materially change a tool's `.html` or `.js` files, bump that tool's version in the same change** — don't wait for the user to ask. Only touch the version of the tool you actually changed.
- A tool still under active/incomplete development also gets a `<span class="wip-badge">Under Construction</span>` next to its version, plus a matching `<span class="wip-badge">WIP</span>` on its sidebar nav entry (`sidebar.js`) and homepage tool card (`index.html`). Remove all three once the user confirms the tool is stable.

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
--input-bg                              # text input / select background
--cyan, --cyan-dim, --cyan-glow
--amber, --red, --green
--text-primary, --text-secondary, --text-muted
--sidebar-w: 240px
--topbar-h: 52px
--radius: 4px
--font: 'JetBrains Mono', monospace
--fs-base: 14px                         # root font-size; scales all rem text
--fs-title, --fs-body, --fs-label, --fs-small, --fs-nav   # per-role text sizes
```

The values here are the built-in defaults **and** the no-Docker fallback. At
container startup `/generated/theme.css` re-declares `:root` with the `.env`
values and is loaded after `main.css`, so it wins. See Theming below.

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
- `.option-toggles.two-col` — two-column grid variant of the toggle list for longer flag sets (cppcap screen output options); collapses to one column at 720px
- `.toggle-flag` — cyan flag badge (e.g. `+`, `-k`) inside a toggle-row
- `.not-toggle` — NOT invert pill button; `.active` = cyan highlight
- `.proto-clear-btn` — inline × next to protocol select; `.active` = visible
- `.filter-reset-btn` — "reset all" text button

**Collapsibles**
- `<details class="collapsible-section">` / `<summary>` — collapsed by default (no `open` attr); inline style for sub-sections *nested inside* a panel (fw-zdebug's zdebug options group, routemap's entry form)
- `<details class="panel input-panel collapsible-panel">` — boxed variant for *top-level* collapsible panels (cppcap, fw-monitor inspection points): keeps the `.panel` border/box and styles the `<summary>` like a `.panel-label` (`// label` text, caret prefix), so collapsed sections match non-collapsible panels
- `.collapsible-body` — padding wrapper for content inside details

**Buttons**
- `.btn-primary` — cyan filled
- `.btn-secondary` — outlined cyan

**Command output**
- `.cmd-output` — dark box with `$` prompt and `<code id="cmdText">`
- `.cmd-output.has-errors` — amber border when validation fails
- `.copy-icon-btn` — small copy icon button (`#copyBtn`) at the right end inside the output box; holds `.icon-copy` + `.icon-check` SVGs, JS toggles `.copied` (green checkmark) on manual copy and auto-copy; disabled when validation fails
- `.cmd-output-wrap` — relative wrapper for `<pre>`-based outputs (routemap) so the copy icon can float top-right
- `.panel-label.cmd-label-row` — the `// generated command` label as a flex row that also carries the single `#copyFeedback` span, so the panel stays compact (no `.cmd-actions` row under the output; `.cmd-actions` is still used by compose-converter for its action buttons)
- `.copy-feedback` (`#copyFeedback`) — one feedback span for all copy states. `showCopied()` shows `copied!` in green for **both** manual and auto copy (no separate auto-copy label); `clearFeedback()` resets it. `.error` (amber) is used for `⚠ fix errors above` while validation fails and for a clipboard failure.

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

## Theming (.env)

Admins can override branding and styles without touching source. Because there
is no build step and `html/` is a **read-only** bind mount, env vars are turned
into static assets **at container startup**:

```
.env  →  docker-compose environment:  →  container
      →  docker/40-nettools-config.sh (envsubst)
      →  /usr/share/nginx/generated/{theme.css,config.js}
      →  served at /generated/…  →  loaded by every page
```

- **All vars are optional.** No `.env`, an empty `.env`, or any unset var → the
  built-in default. `docker/40-nettools-config.sh` is the **single source of
  defaults** (they mirror `main.css`); `.env.example` documents them.
- Missing `.env` never errors — `docker-compose.yml` passes each var as
  `${VAR:-}`, and the entrypoint's `: "${VAR:=default}"` fills the blank.
- `theme.css` re-declares `:root` (colors, `--input-bg`, `--font`, `--fs-*`);
  loaded after `main.css` so it wins. `config.js` sets `window.NETTOOLS_CONFIG`
  (`logoText`/`logoAccent` → the two sidebar logo spans, `logoSub` → the
  muted subtitle line, `logoLink` → the logo anchor's `href` (default
  `index.html`), all via `sidebar.js`; `tabTitle` → swaps the "NetTools"
  prefix in each page's `<title>`). These brand vars default to empty, so page
  text is left as-authored unless set.
- Vars: `LOGO_TEXT`, `LOGO_ACCENT`, `LOGO_SUB`, `LOGO_LINK`, `TAB_TITLE`, `COLOR_PRIMARY/WARNING/ERROR/BG/INPUT_BG/BORDER`,
  `FONT_FAMILY`, `TEXT_BASE_SIZE` (scales all rem text) + `TEXT_TITLE/BODY/LABEL/SMALL/NAV_SIZE`.
- `DISABLED_MODULES` — comma-separated tool slugs (filename base, e.g. `mqtt,routemap`);
  all enabled by default. `config.js` removes disabled `.tool-card`s and redirects a
  direct visit to a disabled tool page back to `index.html`; `sidebar.js` removes the
  disabled `.nav-item`s (and any section header left empty). A new tool is enabled
  automatically — no list to maintain.
- `CONTAINER_NAME` (default `nettools`) and `DOCKER_NETWORK` (default `proxy_net`) are
  different: they're substituted by **docker-compose itself** (`${VAR:-default}` in
  `docker-compose.yml`), not rendered by the entrypoint. Don't add them to the
  `environment:` block or the templates.
- Adding a new var: add a default in `40-nettools-config.sh`, a placeholder in
  the relevant template + its envsubst var list, a passthrough line in
  `docker-compose.yml`, and a documented entry in `.env.example`.
- The two `<link>`/`<script>` tags for `/generated/` live in **every** `*.html`
  (theme.css after main.css; config.js before sidebar.js) — add them when
  creating a new tool page.

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

## Repo Hygiene

Keep `.gitignore` and `.claudeignore` up to date as new tools, frameworks, or dev dependencies are introduced — add patterns for any new build artifacts, caches, local config, or editor/tooling files as they show up, rather than letting them leak into commits or Claude's context.

## Git Commits

Whenever Claude is used to update code, add Claude as a co-author on the commit:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

## Constraints

- **No external JS libraries** in the frontend — keep it that way
- **No build step** — all JS is plain ES6, no TypeScript, no bundling
- **CSP is strict**: `connect-src 'none'` except for MQTT ws connections — don't add fetch/XHR calls
- **Mobile support required**: test at 720px breakpoint; inputs must be ≥16px to avoid iOS auto-zoom
