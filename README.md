# TEST THREE

# NetTools

Browser-local network utilities served by nginx in Docker.
**No data ever leaves the user's browser.** All computation is pure client-side JavaScript.

## Quick Start

```bash
# From the parent directory containing your main docker-compose.yml:
docker compose up -d nettools
```

Open **https://fwctl.com** in your browser.

---

## Directory Structure

```
nettools/            # this folder lives one level below your docker-compose.yml
├── Dockerfile
├── docker-compose.yml      # snippet to merge into your parent compose
├── nginx/
│   └── default.conf
└── subnet/                 # web root for the subnet calculator module
    ├── index.html
    ├── css/
    │   └── main.css
    └── js/
        ├── subnet.js
        └── app.js
```

Future modules sit alongside `subnet/` as sibling directories
(e.g. `nettools/cidr/`, `nettools/portref/`).

### Storage approach
The `docker-compose.yml` uses **bind mounts** (`type: bind`) with paths relative
to the **parent** compose file one directory above (e.g. `./subnet`).
There are **no Docker named volumes**.

---

## Merging into an existing docker-compose.yml

Copy the `nettools` service block from `docker-compose.yml` into your parent file.
The volume paths (`./...`) are already relative to that parent location.

---

## Features

### Subnet Calculator
- CIDR notation (`192.168.1.0/24`) or separate IP + mask (`255.255.255.0` or `/24`)
- Network, broadcast, first/last host, mask, wildcard, host counts
- Binary breakdown (IP, mask, network)
- Visual address-space map (proportional, colour-coded)
- Subnet split — divide a network into equal smaller subnets
- RFC scope detection (RFC 1918 private, loopback, link-local, multicast, etc.)
- One-click copy for any result value
- URL parameter support: `?q=10.0.0.0/8` auto-calculates on load

### Adding a new tool
1. Create `nettools/mytool/` with your tool's HTML/CSS/JS.
2. Add a nav entry in `subnet/index.html` pointing to `/mytool/`.
3. Done — nginx serves all directories under the web root automatically.

---

## Commands

| Command | Action |
|---------|--------|
| `docker compose up -d` | Start in background |
| `docker compose down` | Stop and remove containers |
| `docker compose build` | Rebuild image |
| `docker compose logs -f nettools` | Tail nginx logs |

## Changing the port
Edit `docker-compose.yml`:
```yaml
ports:
  - "9000:80"
```

## Security notes
- `Content-Security-Policy` blocks all external connections (`connect-src 'none'`).
- Google Fonts is the only third-party origin (for JetBrains Mono). To go fully
  air-gapped, self-host the font and update the CSP.
- Container runs nginx as non-root (`nginx` user).
