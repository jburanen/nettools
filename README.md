# NetTools

Modular collection of web-based tools hosted in Docker+Nginx. Most computation is pure client-side JavaScript. Can be public-facing or hosted internally for simple quick access. Designed to be hosted behind a reverse proxy such as <a href=https://github.com/NginxProxyManager/nginx-proxy-manager>NPM</a> if it is made publically available.

## Quick Start

```bash
docker compose up -d --build
```

The app is available at **http://&lt;host&gt;:8080** (or whatever host is proxying port 80 on the `proxy_net` network).

Optional: copy `.env.example` to `.env` first to rebrand the site, recolor the
theme, or disable individual tools — see [Configuration](#configuration). No
`.env` is required; every setting falls back to a built-in default.

---

## Directory Structure

```
nettools/
├── Dockerfile
├── docker-compose.yml
├── .env.example            # optional theming / branding / module toggles (copy to .env)
├── deploy.ps1              # push local files to server + git commit/push
├── server-setup.sh         # one-time server setup with GitHub webhook auto-deploy
├── nginx/
│   └── default.conf
├── docker/                 # .env rendered into the container at startup (envsubst)
│   ├── theme.css.template  #   :root color / font / text-size overrides
│   ├── config.js.template  #   logo text, tab title, disabled modules
│   └── 40-nettools-config.sh  # entrypoint: applies defaults, renders both files
├── proxy/                  # Node.js WebSocket↔MQTT tunnel (second compose service)
│   └── server.js
└── html/                   # web root (bind-mounted read-only into the container)
    ├── index.html
    ├── subnet.html
    ├── tcpdump.html
    ├── fw-monitor.html
    ├── fw-zdebug.html
    ├── compose-converter.html
    ├── mqtt.html
    ├── routemap.html
    ├── css/
    │   └── main.css
    └── js/
        ├── sidebar.js          # shared sidebar, nav, and mobile toggle
        ├── subnet.js           # subnet calculator logic
        ├── app.js              # subnet calculator UI controller
        ├── tcpdump.js          # tcpdump command builder
        ├── fw-monitor.js       # fw monitor command builder
        ├── fw-zdebug.js        # fw ctl zdebug command builder
        ├── compose-converter.js
        └── mqtt-client.js
```

---

## Docker Setup

By default the container is named `nettools` and joins an external Docker network called `proxy_net` (expected to be created by a reverse proxy stack, e.g. Nginx Proxy Manager or Traefik). Both are overridable in `.env` via `CONTAINER_NAME` and `DOCKER_NETWORK` (see [Configuration](#configuration)).

```yaml
networks:
  default:
    name: ${DOCKER_NETWORK:-proxy_net}
    external: true
```

If you don't use an external proxy network, remove or comment the `networks` block from `docker-compose.yml` before starting.

The `html/` directory and `nginx/default.conf` are bind-mounted read-only into the container, so you can edit files locally and see changes immediately without rebuilding (just reload the browser).

---

### Automated deploy via GitHub webhook (server-setup.sh)

`server-setup.sh` is a one-time setup script for an Ubuntu/Debian server that:

1. Installs git, Docker, and the `webhook` daemon
2. Clones the repo to the location you specify
3. Writes a deploy script (`/usr/local/bin/nettools-deploy`) that pulls from GitHub and restarts the container
4. Configures a systemd service for the webhook listener
5. Opens the webhook port in ufw

```bash
chmod +x server-setup.sh
./server-setup.sh
```

Edit `GITHUB_USER`, `WEBHOOK_SECRET`, and other variables at the top of the script before running. After setup, add the displayed webhook URL to your GitHub repo under **Settings → Webhooks**.

---

## Configuration

All theming and branding is optional and driven by an `.env` file next to
`docker-compose.yml`. Copy the template and uncomment only what you want:

```bash
cp .env.example .env
# edit .env, then:
docker compose up -d --build
```

There is **no build step for your HTML**. At container startup a small
entrypoint script (`docker/40-nettools-config.sh`) fills in defaults for any
unset variable and renders two files with `envsubst` —
`theme.css` (`:root` overrides) and `config.js` (runtime settings) — served at
`/generated/…` and loaded by every page. Anything you don't set keeps its
built-in default, so an empty or absent `.env` changes nothing.

**Deployment** — `CONTAINER_NAME` (default `nettools`) and `DOCKER_NETWORK`
(default `proxy_net`). These are read by Compose itself, so `docker compose up -d`
applies them without a rebuild.

**Branding** — `LOGO_TEXT` / `LOGO_ACCENT` (the two-tone sidebar logo),
`LOGO_SUB` (logo subtitle), `LOGO_LINK` (where the logo links to; default the
home page), `TAB_TITLE` (browser-tab brand prefix).

**Theme** — `COLOR_PRIMARY`, `COLOR_WARNING`, `COLOR_ERROR`, `COLOR_BG`,
`COLOR_INPUT_BG`, `COLOR_BORDER`, `FONT_FAMILY`, and text sizes
(`TEXT_BASE_SIZE` scales the whole UI; `TEXT_TITLE/BODY/LABEL/SMALL/NAV_SIZE`
fine-tune individual roles).

**Modules** — `DISABLED_MODULES` is a comma-separated list of tools to turn
off; all are enabled by default. A disabled tool is removed from the sidebar
and home grid, and visiting its page directly redirects home. Valid slugs:
`subnet, tcpdump, fw-monitor, fw-zdebug, compose-converter, mqtt, routemap`.

```ini
# example .env
LOGO_TEXT=ACME
LOGO_ACCENT=NET
COLOR_PRIMARY=#ff7a1a
DISABLED_MODULES=mqtt,routemap
```

See `.env.example` for the full, commented list of every variable and its default.

---

## Features

### Subnet Calculator

- CIDR notation (`192.168.1.0/24`) or separate IP + mask (`255.255.255.0` or `/24`)
- Network, broadcast, first/last host, mask, wildcard, host counts
- Binary breakdown (IP, mask, network)
- Visual address-space map (proportional, colour-coded, up to 512 blocks)
- Subnet split — divide a network into equal smaller subnets (shows first 256)
- RFC scope detection (RFC 1918 private, loopback, link-local, multicast, etc.)
- Legacy IP class detection (A/B/C/D/E)
- One-click copy for any result value
- URL parameter support: `?q=10.0.0.0/8` auto-calculates on load
- Bare IP input defaults to `/32`

### tcpdump Builder

- Live command preview — updates as you type, auto-copies after a short pause
- Interface selection with common interface suggestions
- Verbosity (`-v` / `-vv` / `-vvv`), packet count (`-c`), and write-to-file (`-w`)
- Toggles for `-n` / `-nn` (disable resolution), `-p` (no promiscuous mode), `-tttt` (timestamps)
- BPF filter builder: protocol, source host/port, destination host/port, either-direction host/port
- CIDR input (`10.0.0.0/24`) auto-translated to BPF `net` syntax with host-bit correction
- Per-field validation with inline error and warning messages

### fw monitor Builder

- Live command preview with auto-copy
- Inspection point mask (`-m`) — independent toggles for `i` (pre-inbound), `I` (post-inbound), `o` (pre-outbound), `O` (post-outbound)
- Packet count (`-c`), output file (`-o`) with one-click default path fill and clear, DNS resolution toggle (`-u`)
- Filter expression builder: protocol by number (TCP=6, UDP=17, ICMP=1, ESP=50, AH=51), source/destination/either-direction host and port
- CIDR ranges translated to fw monitor mask syntax: `(src & 255.255.255.0) = 10.0.0.0`
- Output is a valid pcap file readable by Wireshark

### fw ctl zdebug Builder

- Live command preview with auto-copy for `fw ctl zdebug [flags] [+] drop | grep …`
- Pre-command flags (`-v`, `-k`, `-s`, `-d`, `-f`, `-e`, `-F`, `-H`) and grep filter pipeline
- Narrow real-time kernel drop output by source/destination IP, port, protocol, drop reason, and interface
- NOT-invert toggles on grep filters, CIDR-to-regex translation, optional capture-to-file (`tee`)
- Collapsible VSX, stop/filter, advanced-flag, and capture sections

### Compose Converter

- Paste a `docker run` command to get a `docker-compose.yml`, or paste a compose file to get `docker run` command(s)
- Direction is auto-detected — no mode switch needed

### MQTT Client

- Connect to an MQTT broker over WebSocket (browser-native) or MQTT (via the bundled `mqtt-proxy` <a href=https://mosquitto.org/>Mosquitto</a> container)
- Browse published topics and values in a live-updating tree

### routemap Builder *(WIP)*

- Build route-map match/set entries and export as Check Point Gaia, Cisco IOS, or Brocade/Ruckus/ICX config
- Paste an existing route-map to keep new sequence numbers from colliding

### Coming in two weeks </inside joke>

- cppcap Builder
- IKE debug Builder
- Route-based VPN Configurator
- Skyline config builder

### Tangent projects that can't be browser local and might spin off

- Troubleshooting Coach
- URL shortener

---

## Security Notes

- `Content-Security-Policy` allows only `'self'` plus Google Fonts; `connect-src` is limited to `ws:`/`wss:` (for the MQTT client's WebSocket tunnel) — no plain HTTP XHR/fetch is permitted.
- `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection`, and `Referrer-Policy: no-referrer` headers are set by nginx.
- Container runs nginx as the non-root `nginx` user.
- Static assets are served read-only from a bind mount.
- To go fully air-gapped, self-host JetBrains Mono and remove the Google Fonts entries from `index.html` and the CSP in `nginx/default.conf`.
