#!/bin/sh
# ============================================================
# NetTools — render themeable config at container startup.
#
# The nginx base image runs every executable in
# /docker-entrypoint.d/ before starting nginx. This script
# fills in defaults for any variable the admin did NOT set in
# .env, then uses envsubst to render:
#
#   theme.css.template  -> /usr/share/nginx/generated/theme.css
#   config.js.template  -> /usr/share/nginx/generated/config.js
#
# The generated dir lives only inside the container, so the
# read-only html/ bind mount and the git repo stay untouched.
# ============================================================
set -eu

# --- Defaults (mirror css/main.css). Brand/title vars intentionally
#     default to empty so page text is left as-authored. -------
: "${LOGO_TEXT:=}"
: "${LOGO_ACCENT:=}"
: "${LOGO_SUB:=}"
: "${LOGO_LINK:=}"
: "${TAB_TITLE:=}"

# Comma-separated module slugs to hide; empty = all modules enabled.
: "${DISABLED_MODULES:=}"

: "${COLOR_BG:=#0b0e14}"
: "${COLOR_INPUT_BG:=#0b0e14}"
: "${COLOR_BORDER:=#253045}"
: "${COLOR_PRIMARY:=#4dd9c0}"
: "${COLOR_WARNING:=#e6a817}"
: "${COLOR_ERROR:=#e05c5c}"

: "${FONT_FAMILY:='JetBrains Mono', 'Fira Code', 'Consolas', monospace}"

: "${TEXT_BASE_SIZE:=14px}"
: "${TEXT_TITLE_SIZE:=1.4rem}"
: "${TEXT_BODY_SIZE:=0.9rem}"
: "${TEXT_LABEL_SIZE:=0.85rem}"
: "${TEXT_SMALL_SIZE:=0.7rem}"
: "${TEXT_NAV_SIZE:=1rem}"

export LOGO_TEXT LOGO_ACCENT LOGO_SUB LOGO_LINK TAB_TITLE DISABLED_MODULES \
       COLOR_BG COLOR_INPUT_BG COLOR_BORDER COLOR_PRIMARY COLOR_WARNING COLOR_ERROR \
       FONT_FAMILY \
       TEXT_BASE_SIZE TEXT_TITLE_SIZE TEXT_BODY_SIZE TEXT_LABEL_SIZE TEXT_SMALL_SIZE TEXT_NAV_SIZE

GEN=/usr/share/nginx/generated
TPL=/etc/nginx/nettools-templates
mkdir -p "$GEN"

# Explicit var lists so envsubst only touches our placeholders
# (leaves any incidental $ in the templates alone).
CSS_VARS='$COLOR_BG $COLOR_INPUT_BG $COLOR_BORDER $COLOR_PRIMARY $COLOR_WARNING $COLOR_ERROR $FONT_FAMILY $TEXT_BASE_SIZE $TEXT_TITLE_SIZE $TEXT_BODY_SIZE $TEXT_LABEL_SIZE $TEXT_SMALL_SIZE $TEXT_NAV_SIZE'
JS_VARS='$LOGO_TEXT $LOGO_ACCENT $LOGO_SUB $LOGO_LINK $TAB_TITLE $DISABLED_MODULES'

envsubst "$CSS_VARS" < "$TPL/theme.css.template" > "$GEN/theme.css"
envsubst "$JS_VARS"  < "$TPL/config.js.template" > "$GEN/config.js"

echo "[nettools] rendered theme.css and config.js from .env"
