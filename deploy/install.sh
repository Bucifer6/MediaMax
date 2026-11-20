#!/usr/bin/env bash
# MediaMax installer for Linux hosts with Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh | sudo bash
#
# or download it, read it, then run it:
#
#   curl -fsSLO https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh
#   less install.sh
#   sudo bash install.sh
#
# It asks a few questions (domain, reverse proxy, CrowdSec/fail2ban, media folders, ...), writes .env and a
# docker-compose.yml into the install folder (default /opt/mediamax), starts everything and waits until
# MediaMax answers. Re-running it reconfigures or upgrades without touching your data. See docs/DEPLOY.md.
#
#   install.sh                 install, or reconfigure an existing install (answers default to the current ones)
#   install.sh --upgrade       pull new images, refresh the deploy files, restart
#   install.sh --status        what is running, health, bans, recent sign-in failures
#   install.sh --uninstall     stop and remove the containers (keeps your data; add --purge to delete it)
#   install.sh --help          every option, and the environment variables for unattended installs
set -euo pipefail

INSTALLER_VERSION="1.0.0"
REPO_RAW_DEFAULT="https://raw.githubusercontent.com/Bucifer6/MediaMax"

# ------------------------------------------------------------------------------------------------ output
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""
fi
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$C_C" "$C_0" "$*"; }
ok()   { printf '%s ok%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%swarning:%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
MediaMax installer

Usage: install.sh [action] [options]

Actions (default: install or reconfigure)
  --upgrade               pull new images, refresh deploy files, restart (no questions)
  --status                show containers, health, URL, bans and recent sign-in failures
  --uninstall             stop and remove the containers; data stays (add --purge to delete it too)

Options (each can also be given as the environment variable in brackets)
  --dir DIR               install folder (MEDIAMAX_INSTALL_DIR, default /opt/mediamax)
  --domain NAME           public name, e.g. media.example.com (MEDIAMAX_DOMAIN)
  --no-domain             no domain: plain http://<server-ip>:8484
  --email ADDR            e-mail for Let's Encrypt expiry notices (ACME_EMAIL)
  --proxy KIND            caddy | nginx | none | existing | tunnel (MEDIAMAX_PROXY, default caddy)
  --security KIND         crowdsec | fail2ban | both | none (MEDIAMAX_SECURITY, default crowdsec)
  --media PATH[:rw]       media folder to mount read-only (repeat; add :rw for read-write)
                          (MEDIAMAX_MEDIA, comma separated)
  --puid N --pgid N       user/group MediaMax runs as (MEDIAMAX_PUID / MEDIAMAX_PGID, auto-detected)
  --tz ZONE               time zone, e.g. Europe/London (MEDIAMAX_TZ, auto-detected)
  --port N                port for http://<server-ip>:N without a domain, or for an existing proxy
                          to connect to (MEDIAMAX_HTTP_PORT, default 8484)
  --hwaccel KIND          auto | none | vaapi | qsv | nvenc (MEDIAMAX_HWACCEL, default auto)
  --tunnel-token TOKEN    Cloudflare Tunnel token, with --proxy tunnel (CLOUDFLARE_TUNNEL_TOKEN)
  --proxy-ip IP           with --proxy existing on another machine: that proxy's address
  --firewall-bouncer      also install the CrowdSec firewall bouncer on this host (nginx/none/existing)
  --auto-upgrade          add a weekly cron job running install.sh --upgrade
  --image IMAGE           MediaMax image (MEDIAMAX_IMAGE, default ghcr.io/bucifer6/mediamax:latest)
  --ref REF               git branch/tag the deploy files come from (MEDIAMAX_REF, default main)
  --staging               use Let's Encrypt's staging CA (testing; certificates are not trusted)
  --no-start              write the files only; don't pull or start anything
  --no-pull               don't pull images (use what is already on this machine)
  --purge                 with --uninstall: also delete config, recordings and logs
  -y, --yes               no questions: use flags, environment, current settings and defaults
  -h, --help              this help

Examples
  sudo bash install.sh
  sudo bash install.sh -y --domain media.example.com --email me@example.com --media /srv/movies --media /srv/tv
  sudo bash install.sh -y --no-domain --proxy none --security fail2ban --media /mnt/nas/media
  sudo /opt/mediamax/install.sh --upgrade
EOF
}

# ------------------------------------------------------------------------------------------------ root
# Docker and /opt need root. Re-run through sudo before anything else, so arguments and MEDIAMAX_*
# environment overrides survive. Piped into bash (curl | bash) there is no file to re-run: ask for sudo.
case " $* " in *" -h "*|*" --help "*) ;; *)
  if [ "$(id -u)" != 0 ]; then
    if command -v sudo >/dev/null 2>&1 && [ -f "${BASH_SOURCE[0]:-}" ]; then
      info "Root rights are needed (Docker, install folder); re-running with sudo."
      exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
    fi
    die "please run as root, e.g.: curl -fsSL $REPO_RAW_DEFAULT/main/deploy/install.sh | sudo bash"
  fi ;;
esac

# --------------------------------------------------------------------------------------------- arguments
ACTION="install"
ASSUME_YES=0
PURGE=0
NO_START=0
NO_PULL=0
LE_STAGING_FLAG=""
FIREWALL_BOUNCER_FLAG=""
AUTO_UPGRADE_FLAG=""
OPT_DOMAIN="${MEDIAMAX_DOMAIN-__unset__}"
OPT_EMAIL="${ACME_EMAIL:-}"
OPT_PROXY="${MEDIAMAX_PROXY:-}"
OPT_SECURITY="${MEDIAMAX_SECURITY:-}"
OPT_MEDIA="${MEDIAMAX_MEDIA:-}"
OPT_PUID="${MEDIAMAX_PUID:-}"
OPT_PGID="${MEDIAMAX_PGID:-}"
OPT_TZ="${MEDIAMAX_TZ:-}"
OPT_HWACCEL="${MEDIAMAX_HWACCEL:-}"
OPT_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
OPT_PROXY_IP=""
OPT_PORT="${MEDIAMAX_HTTP_PORT:-}"
OPT_IMAGE="${MEDIAMAX_IMAGE:-}"
OPT_REF="${MEDIAMAX_REF:-}"
DIR="${MEDIAMAX_INSTALL_DIR:-/opt/mediamax}"

need_arg() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upgrade) ACTION="upgrade" ;;
    --status) ACTION="status" ;;
    --uninstall) ACTION="uninstall" ;;
    --purge) PURGE=1 ;;
    --dir) need_arg "$@"; DIR="$2"; shift ;;
    --domain) need_arg "$@"; OPT_DOMAIN="$2"; shift ;;
    --no-domain) OPT_DOMAIN="" ;;
    --email) need_arg "$@"; OPT_EMAIL="$2"; shift ;;
    --proxy) need_arg "$@"; OPT_PROXY="$2"; shift ;;
    --security) need_arg "$@"; OPT_SECURITY="$2"; shift ;;
    --media) need_arg "$@"; OPT_MEDIA="${OPT_MEDIA:+$OPT_MEDIA,}$2"; shift ;;
    --puid) need_arg "$@"; OPT_PUID="$2"; shift ;;
    --pgid) need_arg "$@"; OPT_PGID="$2"; shift ;;
    --tz) need_arg "$@"; OPT_TZ="$2"; shift ;;
    --hwaccel) need_arg "$@"; OPT_HWACCEL="$2"; shift ;;
    --tunnel-token) need_arg "$@"; OPT_TUNNEL_TOKEN="$2"; shift ;;
    --proxy-ip) need_arg "$@"; OPT_PROXY_IP="$2"; shift ;;
    --port) need_arg "$@"; OPT_PORT="$2"; shift ;;
    --image) need_arg "$@"; OPT_IMAGE="$2"; shift ;;
    --ref) need_arg "$@"; OPT_REF="$2"; shift ;;
    --firewall-bouncer) FIREWALL_BOUNCER_FLAG="yes" ;;
    --auto-upgrade) AUTO_UPGRADE_FLAG="yes" ;;
    --staging) LE_STAGING_FLAG="1" ;;
    --no-start) NO_START=1 ;;
    --no-pull) NO_PULL=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
[ "$PURGE" = 1 ] && [ "$ACTION" != "uninstall" ] && die "--purge only goes with --uninstall"
case "$DIR" in /*) ;; *) die "--dir must be an absolute path" ;; esac
DIR="${DIR%/}"
# Everything is captured above. Remove the overrides from the environment so they can't shadow .env when
# docker compose interpolates docker-compose.yml (the shell environment wins over .env there).
unset MEDIAMAX_HTTP_PORT MEDIAMAX_DOMAIN ACME_EMAIL MEDIAMAX_PROXY MEDIAMAX_SECURITY MEDIAMAX_MEDIA MEDIAMAX_PUID MEDIAMAX_PGID \
  MEDIAMAX_TZ MEDIAMAX_HWACCEL CLOUDFLARE_TUNNEL_TOKEN MEDIAMAX_IMAGE MEDIAMAX_REF MEDIAMAX_INSTALL_DIR \
  COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES

# ------------------------------------------------------------------------------------------ interaction
# Questions go to the terminal even when the script itself arrives on stdin (curl ... | bash).
TTY_OK=0
if [ "$ASSUME_YES" = 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  TTY_OK=1
fi
interactive() { [ "$TTY_OK" = 1 ]; }

# ask VAR "Question" "default"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if interactive; then
    if [ -n "$__def" ]; then printf '%s %s[%s]%s: ' "$__q" "$C_B" "$__def" "$C_0" >/dev/tty
    else printf '%s: ' "$__q" >/dev/tty; fi
    IFS= read -r __ans </dev/tty || __ans=""
  fi
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

# confirm "Question" y|n  -> 0 for yes
confirm() {
  local __q="$1" __def="${2:-n}" __ans=""
  if ! interactive; then [ "$__def" = y ]; return; fi
  if [ "$__def" = y ]; then printf '%s [Y/n]: ' "$__q" >/dev/tty; else printf '%s [y/N]: ' "$__q" >/dev/tty; fi
  IFS= read -r __ans </dev/tty || __ans=""
  [ -z "$__ans" ] && __ans="$__def"
  case "$__ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# choose VAR "Question" default "value|label" ...
choose() {
  local __var="$1" __q="$2" __def="$3" __i=1 __n __ans="" __defn=1 __opt
  shift 3
  if ! interactive; then printf -v "$__var" '%s' "$__def"; return; fi
  printf '%s%s%s\n' "$C_B" "$__q" "$C_0" >/dev/tty
  for __opt in "$@"; do
    [ "${__opt%%|*}" = "$__def" ] && __defn=$__i
    printf '  %d) %s\n' "$__i" "${__opt#*|}" >/dev/tty
    __i=$((__i + 1))
  done
  __n=$#
  while :; do
    printf 'Choice %s[%s]%s: ' "$C_B" "$__defn" "$C_0" >/dev/tty
    IFS= read -r __ans </dev/tty || __ans=""
    [ -z "$__ans" ] && __ans=$__defn
    case "$__ans" in *[!0-9]*) ;; *) if [ "$__ans" -ge 1 ] && [ "$__ans" -le "$__n" ]; then break; fi ;; esac
    printf 'Please answer 1-%d.\n' "$__n" >/dev/tty
  done
  __opt="${*:$__ans:1}"
  printf -v "$__var" '%s' "${__opt%%|*}"
}

# ------------------------------------------------------------------------------------------------ .env
ENV_FILE="$DIR/.env"
# env_get KEY: value from the existing .env (one level of quotes removed), empty if absent.
env_get() {
  local line
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  case "$line" in \'*\') line="${line#\'}"; line="${line%\'}" ;; \"*\") line="${line#\"}"; line="${line%\"}" ;; esac
  printf '%s' "$line"
}
# env_set KEY VALUE: change one key in place (used after the bouncer key is created).
env_set() {
  local tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  grep -vE "^$1=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$1" "$(env_quote "$2")" >>"$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
}
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@,+=-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# -------------------------------------------------------------------------------------------- docker
# docker-compose.override.yml (yours, never touched by the installer) is merged in, as plain
# "docker compose" in the folder would: extra labels, volumes, networks...
dc() {
  local files=(-f "$DIR/docker-compose.yml")
  [ -f "$DIR/docker-compose.override.yml" ] && files+=(-f "$DIR/docker-compose.override.yml")
  docker compose --project-directory "$DIR" "${files[@]}" --env-file "$ENV_FILE" "$@"
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    say "  The official installer is:  curl -fsSL https://get.docker.com | sh"
    say "  (or follow https://docs.docker.com/engine/install/ for your distribution)"
    if confirm "Run Docker's official installer now?" n; then
      curl -fsSL https://get.docker.com | sh
      command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
    else
      die "install Docker, then run this installer again"
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    command -v systemctl >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 || die "the Docker daemon is not running (try: systemctl start docker)"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    warn "The Docker Compose plugin (docker compose) is missing."
    local cmd="curl -fsSL https://get.docker.com | sh"
    if command -v apt-get >/dev/null 2>&1; then cmd="apt-get update && apt-get install -y docker-compose-plugin"
    elif command -v dnf >/dev/null 2>&1; then cmd="dnf install -y docker-compose-plugin"
    elif command -v yum >/dev/null 2>&1; then cmd="yum install -y docker-compose-plugin"; fi
    say "  Install it with:  $cmd"
    say "  (the package comes from Docker's repository; with your distribution's docker.io package use get.docker.com)"
    if confirm "Run that now?" n; then
      sh -c "$cmd"
    else
      die "install the Compose plugin, then run this installer again"
    fi
    docker compose version >/dev/null 2>&1 || die "docker compose still doesn't work"
  fi
  local v major minor
  v="$(docker compose version --short 2>/dev/null || echo 0)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  case "$major$minor" in *[!0-9]*|"") major=0; minor=0 ;; esac
  if [ "$major" -lt 2 ] || { [ "$major" = 2 ] && [ "$minor" -lt 20 ]; }; then
    die "Docker Compose $v is too old; 2.20 or newer is needed (upgrade Docker: curl -fsSL https://get.docker.com | sh)"
  fi
}

container_state() {
  local st
  st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null | tr -d '[:space:]')" || true
  printf '%s' "${st:-missing}"
}

wait_healthy() {
  local name="$1" timeout="${2:-180}" waited=0 state
  while :; do
    state="$(container_state "$name")"
    case "$state" in
      healthy|running) [ "$state" = running ] && [ "$waited" -lt 5 ] || return 0 ;;
      exited|dead|missing) [ "$waited" -ge 20 ] && return 1 ;;
    esac
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 3; waited=$((waited + 3))
  done
}

# ------------------------------------------------------------------------------------------ deploy files
SRC=""
script_dir() {
  local s="${BASH_SOURCE[0]:-}"
  [ -n "$s" ] && [ -f "$s" ] && (cd "$(dirname "$s")" && pwd)
}
# Deploy files come from the checkout next to this script, or from GitHub when the script was piped in
# (or runs from the install folder, e.g. --upgrade), at the branch/tag in MEDIAMAX_REF (default main).
fetch_sources() {
  local here rel
  REF="${OPT_REF:-$(env_get MEDIAMAX_REF)}"; REF="${REF:-main}"
  REPO_RAW="${MEDIAMAX_REPO_RAW:-$REPO_RAW_DEFAULT/$REF}"
  here="$(script_dir || true)"
  if [ -n "$here" ] && [ -f "$here/caddy/Caddyfile" ] && [ -f "$here/crowdsec/acquis.yaml" ] && [ "$here" != "$DIR" ]; then
    SRC="$here"
    info "Using deploy files from $SRC"
    return
  fi
  command -v curl >/dev/null 2>&1 || die "curl is needed to download the deploy files"
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  info "Downloading deploy files from $REPO_RAW/deploy"
  for rel in install.sh caddy/Caddyfile caddy/Dockerfile caddy/conf.d/crowdsec.global caddy/conf.d/crowdsec.site \
             nginx/mediamax-common.conf nginx/mediamax.conf nginx/mediamax-http.conf nginx/snippets/mediamax-locations.conf \
             nginx/40-mediamax-maintenance.sh \
             crowdsec/acquis.yaml crowdsec/parsers/s01-parse/mediamax-logs.yaml crowdsec/scenarios/mediamax-bf.yaml \
             fail2ban/filter.d/mediamax.conf fail2ban/filter.d/mediamax-caddy.conf fail2ban/filter.d/mediamax-nginx.conf \
             fail2ban/jail.d/mediamax.local; do
    mkdir -p "$SRC/$(dirname "$rel")"
    curl -fsSL --retry 3 -o "$SRC/$rel" "$REPO_RAW/deploy/$rel" || die "could not download deploy/$rel from $REPO_RAW"
  done
}

# put SRC_REL DEST: copy, keeping the previous version as DEST.bak when it changed (in place, so file bind
# mounts see the new content). CHANGED collects what changed, to restart only the services concerned.
CHANGED=""
put() {
  local from="$SRC/$1" to="$2"
  [ -f "$from" ] || die "missing deploy file: $1"
  write_if_changed "$to" <"$from"
}
# write_if_changed DEST < content
write_if_changed() {
  local to="$1" tmp
  mkdir -p "$(dirname "$to")"
  tmp="$(mktemp "$(dirname "$to")/.new.XXXXXX")"
  cat >"$tmp"
  if [ -f "$to" ]; then
    if cmp -s "$tmp" "$to"; then rm -f "$tmp"; return 0; fi
    cp -p "$to" "$to.bak"
  fi
  cat "$tmp" >"$to"; rm -f "$tmp"
  CHANGED="$CHANGED ${to#"$DIR"/}"
}

# ------------------------------------------------------------------------------------------- detection
detect_tz() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
  if [ -z "$tz" ] && [ -f /etc/timezone ]; then tz="$(head -n 1 /etc/timezone)"; fi
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then tz="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"; fi
  printf '%s' "${tz:-Etc/UTC}"
}
detect_uid() {
  if [ -n "${SUDO_UID:-}" ] && [ "${SUDO_UID}" != 0 ]; then printf '%s' "$SUDO_UID"; return; fi
  if [ "$(id -u)" != 0 ]; then id -u; return; fi
  getent passwd 2>/dev/null | awk -F: '$3 >= 1000 && $3 < 60000 { print $3; exit }' | grep . || printf '1000'
}
detect_gid() {
  if [ -n "${SUDO_GID:-}" ] && [ "${SUDO_GID}" != 0 ]; then printf '%s' "$SUDO_GID"; return; fi
  local u; u="$(getent passwd "$1" 2>/dev/null | cut -d: -f4)"
  printf '%s' "${u:-$1}"
}
has_nvidia_runtime() { docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null | grep -qw nvidia; }
detect_hwaccel() {
  if command -v nvidia-smi >/dev/null 2>&1 && has_nvidia_runtime; then printf 'nvenc'; return; fi
  if [ -d /dev/dri ] && ls /dev/dri/renderD* >/dev/null 2>&1; then printf 'vaapi'; return; fi
  printf 'none'
}
primary_ip() {
  local ip=""
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')" || true
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')" || true
  printf '%s' "${ip:-<server-ip>}"
}
port_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}
valid_domain() { printf '%s' "$1" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'; }
valid_email() { printf '%s' "$1" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; }

# ------------------------------------------------------------------------------------------ media list
# MEDIA holds "host:container:mode" entries separated by "|".
MEDIA=""
media_add() {
  local spec="$1" path mode="ro" base name n
  spec="${spec%/}"
  case "$spec" in *:rw) path="${spec%:rw}"; mode="rw" ;; *:ro) path="${spec%:ro}" ;; *) path="$spec" ;; esac
  [ -z "$path" ] && return 0
  case "$path" in /*) ;; *) warn "skipping media folder '$path': use an absolute path"; return 0 ;; esac
  case "$path" in *[:\|\$\'\"\\]*) warn "skipping media folder '$path': it contains : | \$ quote or backslash"; return 0 ;; esac
  [ -d "$path" ] || warn "media folder $path doesn't exist (yet); it is mounted anyway"
  case "|$MEDIA|" in *"|$path:"*) return 0 ;; esac
  base="$(basename "$path" | tr -c 'A-Za-z0-9._\n-' '_')"; [ -z "$base" ] || [ "$base" = "/" ] && base="media"
  name="$base"; n=2
  while case "|$MEDIA|" in *":/media/$name:"*) true ;; *) false ;; esac; do name="$base-$n"; n=$((n + 1)); done
  MEDIA="${MEDIA:+$MEDIA|}$path:/media/$name:$mode"
}
media_print() {
  local IFS='|' e
  for e in $MEDIA; do
    printf '    %s -> %s (%s)\n' "${e%%:*}" "$(printf '%s' "$e" | cut -d: -f2)" "$(printf '%s' "$e" | cut -d: -f3)"
  done
}

# ------------------------------------------------------------------------------------------- questions
configure() {
  local cur def

  # Current settings (re-run) are the defaults; flags and environment win over them.
  DOMAIN="$(env_get MEDIAMAX_DOMAIN)"
  EMAIL="$(env_get ACME_EMAIL)"
  PROXY="$(env_get MEDIAMAX_PROXY)"
  SECURITY="$(env_get MEDIAMAX_SECURITY)"
  MEDIA="$(env_get MEDIAMAX_MEDIA_DIRS)"
  PUID="$(env_get MEDIAMAX_PUID)"
  PGID="$(env_get MEDIAMAX_PGID)"
  TZONE="$(env_get MEDIAMAX_TZ)"
  HWACCEL="$(env_get MEDIAMAX_HWACCEL)"
  TUNNEL_TOKEN="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"
  PROXY_IP="$(env_get MEDIAMAX_EXISTING_PROXY_IP)"
  BIND="$(env_get MEDIAMAX_BIND)"
  IMAGE="$(env_get MEDIAMAX_IMAGE)"
  FIREWALL_BOUNCER="$(env_get CROWDSEC_FIREWALL_BOUNCER)"
  AUTO_UPGRADE="$(env_get MEDIAMAX_AUTO_UPGRADE)"
  LE_STAGING="$(env_get LE_STAGING)"
  HTTP_PORT="$(env_get MEDIAMAX_HTTP_PORT)"
  local first_run=1; [ -f "$ENV_FILE" ] && first_run=0

  [ "$OPT_DOMAIN" != "__unset__" ] && DOMAIN="$OPT_DOMAIN"
  [ -n "$OPT_EMAIL" ] && EMAIL="$OPT_EMAIL"
  [ -n "$OPT_PROXY" ] && PROXY="$OPT_PROXY"
  [ -n "$OPT_SECURITY" ] && SECURITY="$OPT_SECURITY"
  [ -n "$OPT_PUID" ] && PUID="$OPT_PUID"
  [ -n "$OPT_PGID" ] && PGID="$OPT_PGID"
  [ -n "$OPT_TZ" ] && TZONE="$OPT_TZ"
  [ -n "$OPT_HWACCEL" ] && HWACCEL="$OPT_HWACCEL"
  [ -n "$OPT_TUNNEL_TOKEN" ] && TUNNEL_TOKEN="$OPT_TUNNEL_TOKEN"
  [ -n "$OPT_PROXY_IP" ] && PROXY_IP="$OPT_PROXY_IP"
  [ -n "$OPT_IMAGE" ] && IMAGE="$OPT_IMAGE"
  [ -n "$FIREWALL_BOUNCER_FLAG" ] && FIREWALL_BOUNCER="yes"
  [ -n "$AUTO_UPGRADE_FLAG" ] && AUTO_UPGRADE="yes"
  [ -n "$LE_STAGING_FLAG" ] && LE_STAGING="1"
  [ -n "$OPT_PORT" ] && HTTP_PORT="$OPT_PORT"
  : "${HTTP_PORT:=8484}"
  case "$HTTP_PORT" in *[!0-9]*|"") die "--port must be a number" ;; esac
  : "${IMAGE:=ghcr.io/bucifer6/mediamax:latest}"
  : "${PROXY:=caddy}"
  : "${HWACCEL:=auto}"

  if interactive; then
    say ""
    say "${C_B}MediaMax installer $INSTALLER_VERSION${C_0}  (install folder: $DIR)"
    [ "$first_run" = 0 ] && say "Existing install found: press Enter to keep each current answer."
    say ""
  fi

  # Domain
  if [ "$OPT_DOMAIN" = "__unset__" ] && interactive; then
    say "A domain name (e.g. media.example.com, pointing at this server) gives you HTTPS with a free certificate."
    say "Leave it empty to use http://$(primary_ip):$HTTP_PORT on your network."
    while :; do
      ask DOMAIN "Domain (empty for none)" "$DOMAIN"
      [ "$DOMAIN" = "-" ] && DOMAIN=""
      [ -z "$DOMAIN" ] || valid_domain "$DOMAIN" && break
      say "That doesn't look like a domain name."
    done
  fi
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
  [ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || die "invalid domain: $DOMAIN"

  # Reverse proxy
  if [ -z "$OPT_PROXY" ]; then
    choose PROXY "Reverse proxy (HTTPS, compression, security headers in front of MediaMax):" "$PROXY" \
      "caddy|Caddy (recommended: automatic HTTPS)" \
      "nginx|Nginx + Certbot" \
      "none|None: MediaMax directly on port $HTTP_PORT" \
      "existing|I already have one (Nginx, NPM, Traefik, ...): show me the settings" \
      "tunnel|Cloudflare Tunnel: no open ports"
  fi
  case "$PROXY" in caddy|nginx|none|existing|tunnel) ;; *) die "--proxy must be caddy, nginx, none, existing or tunnel" ;; esac
  if [ -n "$DOMAIN" ] && [ "$PROXY" = none ]; then
    warn "a domain without a reverse proxy gets no HTTPS; MediaMax will answer on port $HTTP_PORT only"
  fi

  # E-mail for Let's Encrypt
  if [ -n "$DOMAIN" ] && { [ "$PROXY" = caddy ] || [ "$PROXY" = nginx ]; }; then
    if [ -z "$OPT_EMAIL" ] && interactive; then
      while :; do
        ask EMAIL "E-mail for Let's Encrypt certificate notices (empty to skip)" "$EMAIL"
        [ -z "$EMAIL" ] || valid_email "$EMAIL" && break
        say "That doesn't look like an e-mail address."
      done
    fi
    [ -z "$EMAIL" ] || valid_email "$EMAIL" || die "invalid e-mail: $EMAIL"
    if port_busy 80 || port_busy 443; then
      if [ -z "$(dc_ps_quiet)" ]; then
        warn "port 80 or 443 is already in use on this host; the proxy needs both for HTTPS (check: ss -ltnp)"
      fi
    fi
    if command -v getent >/dev/null 2>&1 && ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
      warn "$DOMAIN doesn't resolve yet; create a DNS A/AAAA record for this server before the certificate is requested"
    fi
  fi

  # Existing proxy: where is it?
  if [ "$PROXY" = existing ]; then
    if [ -z "$OPT_PROXY_IP" ] && interactive; then
      say "MediaMax will listen on 127.0.0.1:$HTTP_PORT for a proxy on this server (or one in Docker joined to the"
      say "'mediamax' network). If your proxy runs on another machine, enter its IP address."
      ask PROXY_IP "IP of a proxy on another machine (empty if it is on this server)" "$PROXY_IP"
    fi
    if [ -n "$PROXY_IP" ]; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi
  fi

  # Cloudflare Tunnel token
  if [ "$PROXY" = tunnel ]; then
    if [ -z "$OPT_TUNNEL_TOKEN" ] && interactive; then
      say "Create a tunnel in Cloudflare Zero Trust (Networks → Tunnels → Create, type Cloudflared), copy the token"
      say "from the 'docker run' command it shows, and add a public hostname with service http://mediamax:8484."
      ask TUNNEL_TOKEN "Tunnel token" "$TUNNEL_TOKEN"
    fi
    [ -n "$TUNNEL_TOKEN" ] || die "--proxy tunnel needs a Cloudflare Tunnel token (--tunnel-token)"
  fi

  # Security
  def="${SECURITY:-crowdsec}"
  [ -z "$SECURITY" ] && [ "$PROXY" = tunnel ] && def="none"
  if [ -z "$OPT_SECURITY" ]; then
    [ "$PROXY" = tunnel ] && interactive && say "(Behind Cloudflare Tunnel, firewall bans can't see visitors' addresses: use Cloudflare's WAF instead.)"
    choose SECURITY "Block password guessing and scanners:" "$def" \
      "crowdsec|CrowdSec (recommended: community blocklist + MediaMax scenarios)" \
      "fail2ban|fail2ban (local bans from the MediaMax security log)" \
      "both|Both" \
      "none|None (MediaMax still locks accounts after repeated failures)"
  else
    SECURITY="$def"
  fi
  case "$SECURITY" in crowdsec|fail2ban|both|none) ;; *) die "--security must be crowdsec, fail2ban, both or none" ;; esac

  if has_crowdsec && [ "$PROXY" != caddy ] && [ "$PROXY" != tunnel ] && [ -z "$FIREWALL_BOUNCER_FLAG" ]; then
    if interactive; then
      say "CrowdSec only detects; something must block. With Caddy that is built in. Here, the CrowdSec firewall"
      say "bouncer on this host does it (packages from packagecloud.io/crowdsec, via https://install.crowdsec.net)."
      if confirm "Install the CrowdSec firewall bouncer on this host?" "$( [ "$FIREWALL_BOUNCER" = no ] && echo n || echo y )"; then
        FIREWALL_BOUNCER="yes"; else FIREWALL_BOUNCER="no"; fi
    else
      : "${FIREWALL_BOUNCER:=no}"
    fi
  fi
  has_crowdsec || FIREWALL_BOUNCER="no"
  [ "$PROXY" = caddy ] && [ "$FIREWALL_BOUNCER" != yes ] && FIREWALL_BOUNCER="no"
  : "${FIREWALL_BOUNCER:=no}"

  # Media folders
  local entry
  if [ -n "$OPT_MEDIA" ]; then
    MEDIA=""
    local IFS_SAVE="$IFS"; IFS=','
    for entry in $OPT_MEDIA; do IFS="$IFS_SAVE"; media_add "$entry"; IFS=','; done
    IFS="$IFS_SAVE"
  elif interactive; then
    if [ -n "$MEDIA" ]; then
      say "Media folders now mounted:"; media_print
      confirm "Keep these?" y || MEDIA=""
    fi
    say "Media folders to make available to MediaMax, mounted read-only under /media/<name>."
    say "Enter one host path per line (add :rw for read-write, e.g. for DVR or photo uploads); empty line to finish."
    while :; do
      ask entry "Media folder" ""
      [ -z "$entry" ] && break
      media_add "$entry"
    done
  fi

  # PUID / PGID
  cur="${PUID:-$(detect_uid)}"
  if [ -z "$OPT_PUID" ] && interactive; then
    say "MediaMax runs as a normal user so files it creates belong to you (find yours with: id <username>)."
    ask PUID "PUID (user id)" "$cur"
  else
    PUID="$cur"
  fi
  cur="${PGID:-$(detect_gid "$PUID")}"
  if [ -z "$OPT_PGID" ] && interactive; then ask PGID "PGID (group id)" "$cur"; else PGID="$cur"; fi
  case "$PUID$PGID" in *[!0-9]*|"") die "PUID and PGID must be numbers" ;; esac

  # Time zone
  cur="${TZONE:-$(detect_tz)}"
  if [ -z "$OPT_TZ" ] && interactive; then ask TZONE "Time zone" "$cur"; else TZONE="$cur"; fi
  [ -e "/usr/share/zoneinfo/$TZONE" ] || [ ! -d /usr/share/zoneinfo ] || warn "unknown time zone '$TZONE' (see timedatectl list-timezones)"

  # Hardware transcoding
  local detected; detected="$(detect_hwaccel)"
  [ "$HWACCEL" = auto ] && HWACCEL="$detected"
  if [ -z "$OPT_HWACCEL" ] && interactive; then
    local hint="none found"
    [ -d /dev/dri ] && hint="/dev/dri found (Intel/AMD)"
    command -v nvidia-smi >/dev/null 2>&1 && { has_nvidia_runtime && hint="NVIDIA GPU + container toolkit found" || hint="NVIDIA GPU found, but no NVIDIA container toolkit"; }
    choose HWACCEL "Hardware transcoding ($hint):" "$HWACCEL" \
      "vaapi|Intel / AMD (VA-API, /dev/dri)" \
      "qsv|Intel Quick Sync (/dev/dri)" \
      "nvenc|NVIDIA (needs the NVIDIA Container Toolkit)" \
      "none|None (software)"
  fi
  case "$HWACCEL" in none|vaapi|qsv|nvenc) ;; *) die "--hwaccel must be auto, none, vaapi, qsv or nvenc" ;; esac
  if { [ "$HWACCEL" = vaapi ] || [ "$HWACCEL" = qsv ]; } && [ ! -d /dev/dri ]; then
    warn "/dev/dri doesn't exist on this host; hardware transcoding is turned off"; HWACCEL="none"
  fi
  if [ "$HWACCEL" = nvenc ] && ! has_nvidia_runtime; then
    warn "the NVIDIA Container Toolkit isn't set up (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html); hardware transcoding is turned off"
    HWACCEL="none"
  fi

  # Weekly upgrades
  if [ -z "$AUTO_UPGRADE_FLAG" ] && interactive; then
    if confirm "Upgrade automatically every Sunday at 04:17 (cron running install.sh --upgrade)?" "$( [ "$AUTO_UPGRADE" = yes ] && echo y || echo n )"; then
      AUTO_UPGRADE="yes"; else AUTO_UPGRADE="no"; fi
  fi
  : "${AUTO_UPGRADE:=no}"

  # Install folder last, so a re-run can point elsewhere before anything is written.
  derive
  summary
  if interactive && ! confirm "Go ahead?" y; then die "nothing was changed"; fi
}

has_crowdsec() { [ "$SECURITY" = crowdsec ] || [ "$SECURITY" = both ]; }
has_fail2ban() { [ "$SECURITY" = fail2ban ] || [ "$SECURITY" = both ]; }
dc_ps_quiet() { [ -f "$DIR/docker-compose.yml" ] && dc ps -q 2>/dev/null || true; }

# Values that follow from the answers.
derive() {
  SUBNET="$(env_get MEDIAMAX_SUBNET)"; : "${SUBNET:=172.30.84.0/24}"
  TRANSCODE_SIZE="$(env_get MEDIAMAX_TRANSCODE_SIZE)"; : "${TRANSCODE_SIZE:=4g}"
  LAPI_PORT="$(env_get CROWDSEC_LAPI_PORT)"; : "${LAPI_PORT:=8090}"
  BOUNCER_KEY="$(env_get CROWDSEC_BOUNCER_KEY)"
  case "$PROXY" in
    caddy|nginx)
      # Only the proxy is reachable from outside; MediaMax is on the internal network (and on loopback
      # when the proxy doesn't need port 8484 itself).
      TRUSTED="loopback,$SUBNET"
      if [ -n "$DOMAIN" ]; then BIND="127.0.0.1"; else BIND=""; fi ;;
    tunnel) TRUSTED="loopback,$SUBNET"; BIND="127.0.0.1" ;;
    existing)
      TRUSTED="loopback,$SUBNET"; [ -n "$PROXY_IP" ] && TRUSTED="$TRUSTED,$PROXY_IP"
      : "${BIND:=127.0.0.1}" ;;
    none)
      # Nobody is in front: don't believe X-Forwarded-For from anyone (no spoofed addresses in the logs).
      TRUSTED="loopback"; BIND="0.0.0.0" ;;
  esac
  if [ -n "$DOMAIN" ] && [ "$PROXY" = caddy ]; then SITE_ADDRESS="$DOMAIN"; else SITE_ADDRESS=":8484"; fi
  PROFILES=""
  case "$PROXY" in caddy) PROFILES="caddy" ;; nginx) PROFILES="nginx" ;; tunnel) PROFILES="tunnel" ;; esac
  has_crowdsec && PROFILES="${PROFILES:+$PROFILES,}crowdsec"
  has_fail2ban && PROFILES="${PROFILES:+$PROFILES,}fail2ban"
  CADDY_BOUNCER=no
  [ "$PROXY" = caddy ] && has_crowdsec && CADDY_BOUNCER=yes
  return 0
}

public_url() {
  if [ -n "$DOMAIN" ] && { [ "$PROXY" = caddy ] || [ "$PROXY" = nginx ]; }; then printf 'https://%s' "$DOMAIN"
  elif [ "$PROXY" = tunnel ]; then printf 'https://<your tunnel hostname>'
  elif [ "$PROXY" = existing ]; then printf 'https://%s (through your proxy)' "${DOMAIN:-<your proxy name>}"
  else printf 'http://%s:%s' "$(primary_ip)" "$HTTP_PORT"; fi
}

summary() {
  say ""
  say "${C_B}Summary${C_0}"
  say "  Install folder : $DIR"
  say "  Address        : $(public_url)"
  say "  Reverse proxy  : $PROXY$( [ -n "$EMAIL" ] && [ -n "$DOMAIN" ] && printf ' (Let'"'"'s Encrypt e-mail %s)' "$EMAIL")"
  say "  Security       : $SECURITY$( [ "$FIREWALL_BOUNCER" = yes ] && printf ' + CrowdSec firewall bouncer on the host')"
  say "  Media folders  :"; if [ -n "$MEDIA" ]; then media_print; else say "    (none yet: add later by re-running the installer)"; fi
  say "  Runs as        : $PUID:$PGID, time zone $TZONE"
  say "  HW transcoding : $HWACCEL"
  say "  Auto-upgrade   : $AUTO_UPGRADE"
  say ""
}

# ---------------------------------------------------------------------------------------------- writing
write_env() {
  local tmp key
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  {
    say "# MediaMax deployment settings, written by deploy/install.sh $INSTALLER_VERSION."
    say "# Re-run the installer to change them, or edit and run: docker compose up -d"
    say "# Extra MediaMax settings (TMDB_API_KEY, ...) go in mediamax.env."
    say "COMPOSE_PROJECT_NAME=mediamax"
    say "COMPOSE_PROFILES=$(env_quote "$PROFILES")"
    say "MEDIAMAX_IMAGE=$(env_quote "$IMAGE")"
    say "MEDIAMAX_REF=$(env_quote "${REF:-main}")"
    say "MEDIAMAX_DOMAIN=$(env_quote "$DOMAIN")"
    say "ACME_EMAIL=$(env_quote "$EMAIL")"
    say "LE_STAGING=$(env_quote "${LE_STAGING:-}")"
    say "MEDIAMAX_PROXY=$PROXY"
    say "MEDIAMAX_SECURITY=$SECURITY"
    say "MEDIAMAX_SITE_ADDRESS=$(env_quote "$SITE_ADDRESS")"
    say "MEDIAMAX_BIND=$(env_quote "$BIND")"
    say "MEDIAMAX_HTTP_PORT=$HTTP_PORT"
    say "MEDIAMAX_EXISTING_PROXY_IP=$(env_quote "$PROXY_IP")"
    say "MEDIAMAX_SUBNET=$(env_quote "$SUBNET")"
    say "MEDIAMAX_TRUSTED_PROXIES=$(env_quote "$TRUSTED")"
    say "MEDIAMAX_MEDIA_DIRS=$(env_quote "$MEDIA")"
    say "MEDIAMAX_PUID=$PUID"
    say "MEDIAMAX_PGID=$PGID"
    say "MEDIAMAX_TZ=$(env_quote "$TZONE")"
    say "MEDIAMAX_HWACCEL=$HWACCEL"
    say "MEDIAMAX_TRANSCODE_SIZE=$(env_quote "$TRANSCODE_SIZE")"
    say "MEDIAMAX_AUTO_UPGRADE=$AUTO_UPGRADE"
    say "CROWDSEC_BOUNCER_KEY=$(env_quote "$BOUNCER_KEY")"
    say "CROWDSEC_FIREWALL_BOUNCER=$FIREWALL_BOUNCER"
    say "CROWDSEC_LAPI_PORT=$(env_quote "$LAPI_PORT")"
    say "CLOUDFLARE_TUNNEL_TOKEN=$(env_quote "$TUNNEL_TOKEN")"
    # Keep anything else someone added by hand.
    if [ -f "$ENV_FILE" ]; then
      local known=" COMPOSE_PROJECT_NAME COMPOSE_PROFILES MEDIAMAX_IMAGE MEDIAMAX_REF MEDIAMAX_DOMAIN ACME_EMAIL LE_STAGING MEDIAMAX_PROXY MEDIAMAX_SECURITY MEDIAMAX_SITE_ADDRESS MEDIAMAX_BIND MEDIAMAX_HTTP_PORT MEDIAMAX_EXISTING_PROXY_IP MEDIAMAX_SUBNET MEDIAMAX_TRUSTED_PROXIES MEDIAMAX_MEDIA_DIRS MEDIAMAX_PUID MEDIAMAX_PGID MEDIAMAX_TZ MEDIAMAX_HWACCEL MEDIAMAX_TRANSCODE_SIZE MEDIAMAX_AUTO_UPGRADE CROWDSEC_BOUNCER_KEY CROWDSEC_FIREWALL_BOUNCER CROWDSEC_LAPI_PORT CLOUDFLARE_TUNNEL_TOKEN "
      local first=1 line
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        key="${line%%=*}"
        case "$known" in *" $key "*) continue ;; esac
        [ "$first" = 1 ] && { say ""; say "# Your own additions"; first=0; }
        say "$line"
      done <"$ENV_FILE"
    fi
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# YAML double-quoted string.
yq() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

write_compose() {
  local f="$DIR/docker-compose.yml" tmp
  tmp="$(mktemp "$DIR/.compose.XXXXXX")"
  {
    cat <<'EOF'
# MediaMax: generated by deploy/install.sh from the answers in .env.
# Re-run the installer to change it; manual edits are replaced (the previous file is kept as
# docker-compose.yml.bak). Put your own additions in docker-compose.override.yml (kept, and merged by
# docker compose automatically). Settings for MediaMax itself go in mediamax.env.
#
# Optional services are switched on by COMPOSE_PROFILES in .env (caddy, nginx, crowdsec, fail2ban, tunnel).
# Pin versions by adding e.g. MEDIAMAX_IMAGE=ghcr.io/bucifer6/mediamax:0.3.0, CADDY_IMAGE=caddy:2.11,
# NGINX_IMAGE, CERTBOT_IMAGE, CROWDSEC_IMAGE, FAIL2BAN_IMAGE or CLOUDFLARED_IMAGE to .env.
# Backups: MediaMax makes its own (Admin → Backups), stored in ./config/backups. Copy that folder off this
# machine now and then.
name: mediamax

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

networks:
  mediamax:
    name: mediamax
    ipam:
      config:
        - subnet: ${MEDIAMAX_SUBNET:-172.30.84.0/24}

volumes:
  caddy-data:
  caddy-config:
  crowdsec-db:
  crowdsec-config:

services:
  mediamax:
    image: ${MEDIAMAX_IMAGE:-ghcr.io/bucifer6/mediamax:latest}
    container_name: mediamax
    restart: unless-stopped
    networks: [mediamax]
EOF
    if [ -n "$BIND" ]; then
      cat <<'EOF'
    ports:
      - "${MEDIAMAX_BIND:-127.0.0.1}:${MEDIAMAX_HTTP_PORT:-8484}:8484"
EOF
    fi
    cat <<'EOF'
    environment:
      PUID: ${MEDIAMAX_PUID:-1000}
      PGID: ${MEDIAMAX_PGID:-1000}
      TZ: ${MEDIAMAX_TZ:-Etc/UTC}
      # X-Forwarded-For is only believed from these (the proxy on the Docker network); see server/src/app.ts.
      MEDIAMAX_TRUSTED_PROXIES: ${MEDIAMAX_TRUSTED_PROXIES:-loopback}
      MEDIAMAX_HWACCEL: ${MEDIAMAX_HWACCEL:-none}
    env_file:
      - ./mediamax.env
    volumes:
      - ./config:/config            # database, artwork, logs (logs/security.log), backups (backups/)
      - ./recordings:/recordings    # DVR recordings
EOF
    local IFS='|' e host ctr mode
    for e in $MEDIA; do
      host="${e%%:*}"; ctr="$(printf '%s' "$e" | cut -d: -f2)"; mode="$(printf '%s' "$e" | cut -d: -f3)"
      printf '      - %s\n' "$(yq "$host:$ctr:$mode")"
    done
    unset IFS
    cat <<'EOF'
    tmpfs:
      - /transcode:size=${MEDIAMAX_TRANSCODE_SIZE:-4g}   # RAM disk for HLS segments
EOF
    case "$HWACCEL" in
      vaapi|qsv) cat <<'EOF'
    devices:
      - /dev/dri:/dev/dri           # Intel/AMD GPU; the entrypoint joins its render/video groups
EOF
      ;;
      nvenc) cat <<'EOF'
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, video]
EOF
      ;;
    esac
    cat <<'EOF'
    # The entrypoint starts as root only to fix ownership and drop to PUID/PGID (setpriv), which
    # no-new-privileges allows; nothing in the container may gain privileges after that.
    security_opt:
      - no-new-privileges:true
    cap_drop: [NET_RAW, MKNOD, AUDIT_WRITE, SYS_CHROOT, SETFCAP]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8484/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging: *logging
EOF

    if [ "$PROXY" = caddy ]; then
      say ""
      say "  caddy:"
      if [ "$CADDY_BOUNCER" = yes ]; then
        cat <<'EOF'
    # Caddy with the CrowdSec bouncer module, built from ./caddy/Dockerfile.
    build:
      context: ./caddy
    image: mediamax-caddy:crowdsec
EOF
      else
        # shellcheck disable=SC2016  # a compose variable, written literally
        say '    image: ${CADDY_IMAGE:-caddy:2}'
      fi
      cat <<'EOF'
    container_name: mediamax-caddy
    profiles: [caddy]
    restart: unless-stopped
    networks: [mediamax]
    depends_on:
      mediamax:
        condition: service_healthy
EOF
      if [ "$CADDY_BOUNCER" = yes ]; then
        cat <<'EOF'
      crowdsec:
        condition: service_healthy
EOF
      fi
      if [ -n "$DOMAIN" ]; then
        cat <<'EOF'
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"               # HTTP/3
EOF
      else
        cat <<'EOF'
    ports:
      - "${MEDIAMAX_HTTP_PORT:-8484}:8484"
EOF
      fi
      cat <<'EOF'
    environment:
      MEDIAMAX_SITE_ADDRESS: ${MEDIAMAX_SITE_ADDRESS:-:8484}
      MEDIAMAX_UPSTREAM: mediamax:8484
      CROWDSEC_BOUNCER_KEY: ${CROWDSEC_BOUNCER_KEY:-}
      CROWDSEC_LAPI_URL: http://crowdsec:8080
    volumes:
      - ./caddy:/etc/caddy:ro       # Caddyfile, conf.d/
      - ./logs/caddy:/var/log/caddy # access.log (JSON) for CrowdSec / fail2ban
      - caddy-data:/data            # certificates
      - caddy-config:/config
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging: *logging
EOF
    fi

    if [ "$PROXY" = nginx ]; then
      cat <<'EOF'

  nginx:
    image: ${NGINX_IMAGE:-nginx:stable-alpine}
    container_name: mediamax-nginx
    profiles: [nginx]
    restart: unless-stopped
    networks: [mediamax]
    depends_on:
      mediamax:
        condition: service_healthy
EOF
      if [ -n "$DOMAIN" ]; then
        cat <<'EOF'
    ports:
      - "80:80"
      - "443:443"
EOF
      else
        cat <<'EOF'
    ports:
      - "${MEDIAMAX_HTTP_PORT:-8484}:8484"
EOF
      fi
      cat <<'EOF'
    environment:
      MEDIAMAX_DOMAIN: ${MEDIAMAX_DOMAIN:-}
      MEDIAMAX_UPSTREAM: mediamax:8484
      NGINX_ENVSUBST_FILTER: "^MEDIAMAX_"   # templates only see MEDIAMAX_*; $host etc. stay nginx variables
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
      - ./nginx/snippets:/etc/nginx/mediamax:ro
      - ./letsencrypt:/etc/letsencrypt:ro
      - ./certbot-www:/var/www/certbot:ro
      - ./logs/nginx:/var/log/nginx
      # Every 6 hours: rotate the logs above past 50 MB, reload to pick up renewed certificates.
      - ./nginx/40-mediamax-maintenance.sh:/docker-entrypoint.d/40-mediamax-maintenance.sh:ro
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/nginx-health"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging: *logging
EOF
      if [ -n "$DOMAIN" ]; then
        cat <<'EOF'

  certbot:
    image: ${CERTBOT_IMAGE:-certbot/certbot:latest}
    container_name: mediamax-certbot
    profiles: [nginx]
    restart: unless-stopped
    volumes:
      - ./letsencrypt:/etc/letsencrypt
      - ./certbot-www:/var/www/certbot
    # Renewal: certbot only renews certificates that expire within 30 days.
    entrypoint: ["/bin/sh", "-c", "trap exit TERM; while :; do certbot renew --webroot -w /var/www/certbot --quiet; sleep 12h & wait $${!}; done"]
    security_opt:
      - no-new-privileges:true
    logging: *logging
EOF
      fi
    fi

    if has_crowdsec; then
      local coll="crowdsecurity/linux crowdsecurity/http-cve crowdsecurity/base-http-scenarios"
      case "$PROXY" in caddy) coll="crowdsecurity/caddy $coll" ;; nginx) coll="crowdsecurity/nginx $coll" ;; esac
      cat <<EOF

  crowdsec:
    image: \${CROWDSEC_IMAGE:-crowdsecurity/crowdsec:latest}
    container_name: mediamax-crowdsec
    profiles: [crowdsec]
    restart: unless-stopped
    networks: [mediamax]
    environment:
      TZ: \${MEDIAMAX_TZ:-Etc/UTC}
      # Installed (and kept up to date) from the CrowdSec Hub at every start. Add more with
      # CROWDSEC_COLLECTIONS in .env (e.g. "$coll crowdsecurity/sshd").
      COLLECTIONS: "\${CROWDSEC_COLLECTIONS-$coll}"
EOF
      if [ "$FIREWALL_BOUNCER" = yes ]; then
        cat <<'EOF'
    ports:
      - "127.0.0.1:${CROWDSEC_LAPI_PORT:-8090}:8080"   # for the firewall bouncer on the host only
EOF
      fi
      cat <<'EOF'
    volumes:
      - ./crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro
      - ./crowdsec/parsers/s01-parse/mediamax-logs.yaml:/etc/crowdsec/parsers/s01-parse/mediamax-logs.yaml:ro
      - ./crowdsec/scenarios/mediamax-bf.yaml:/etc/crowdsec/scenarios/mediamax-bf.yaml:ro
      - crowdsec-db:/var/lib/crowdsec/data
      - crowdsec-config:/etc/crowdsec
      - ./config/logs:/var/log/mediamax:ro
      - ./logs/caddy:/var/log/caddy:ro
      - ./logs/nginx:/var/log/nginx:ro
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "cscli", "lapi", "status"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 90s
    logging: *logging
EOF
    fi

    if has_fail2ban; then
      cat <<'EOF'

  fail2ban:
    image: ${FAIL2BAN_IMAGE:-crazymax/fail2ban:latest}
    container_name: mediamax-fail2ban
    profiles: [fail2ban]
    restart: unless-stopped
    # Host network + NET_ADMIN: bans are iptables rules on the host (DOCKER-USER and INPUT chains), see
    # fail2ban/jail.d/mediamax.local for why DOCKER-USER.
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    environment:
      TZ: ${MEDIAMAX_TZ:-Etc/UTC}
      F2B_LOG_TARGET: STDOUT
      F2B_LOG_LEVEL: INFO
      F2B_DB_PURGE_AGE: 30d
    volumes:
      - ./fail2ban:/data            # jail.d/, filter.d/, database
      - ./config/logs:/var/log/mediamax:ro
      - ./logs/caddy:/var/log/caddy:ro
      - ./logs/nginx:/var/log/nginx:ro
    security_opt:
      - no-new-privileges:true
    logging: *logging
EOF
    fi

    if [ "$PROXY" = tunnel ]; then
      cat <<'EOF'

  cloudflared:
    image: ${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}
    container_name: mediamax-cloudflared
    profiles: [tunnel]
    restart: unless-stopped
    networks: [mediamax]
    depends_on:
      mediamax:
        condition: service_healthy
    command: ["tunnel", "--no-autoupdate", "run"]
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?set CLOUDFLARE_TUNNEL_TOKEN in .env}
    security_opt:
      - no-new-privileges:true
    logging: *logging
EOF
    fi
  } >"$tmp"
  if [ -f "$f" ] && ! cmp -s "$tmp" "$f"; then cp -p "$f" "$f.bak"; fi
  mv "$tmp" "$f"
  chmod 644 "$f"
}

install_files() {
  info "Writing configuration to $DIR"
  mkdir -p "$DIR"/{logs/caddy,logs/nginx}
  # A new data folder belongs to PUID:PGID. An existing one is left alone: if PUID changed, the container's
  # entrypoint notices the old owner and fixes the whole folder itself.
  if [ ! -d "$DIR/config" ]; then mkdir -p "$DIR/config/logs"; chown -R "$PUID:$PGID" "$DIR/config"; fi
  if [ ! -d "$DIR/recordings" ]; then mkdir -p "$DIR/recordings"; chown "$PUID:$PGID" "$DIR/recordings"; fi
  # The security log exists from the start, so fail2ban and CrowdSec have a file to watch.
  if [ ! -f "$DIR/config/logs/security.log" ]; then
    mkdir -p "$DIR/config/logs"
    touch "$DIR/config/logs/security.log"
    chown "$(stat -c %u:%g "$DIR/config")" "$DIR/config/logs" "$DIR/config/logs/security.log"
  fi
  [ -f "$DIR/mediamax.env" ] || cat >"$DIR/mediamax.env" <<'EOF'
# Extra settings for the MediaMax container (KEY=value, one per line), for example:
# TMDB_API_KEY=your_tmdb_key
# MEDIAMAX_EXTRA_GIDS=1001
EOF
  chmod 600 "$DIR/mediamax.env"

  # The installer itself, for --upgrade / --status / --uninstall later.
  if [ "$SRC/install.sh" != "$DIR/install.sh" ]; then
    cat "$SRC/install.sh" >"$DIR/.install.sh.new" && chmod 755 "$DIR/.install.sh.new" && mv "$DIR/.install.sh.new" "$DIR/install.sh"
  fi

  # Reverse proxy
  put caddy/Caddyfile "$DIR/caddy/Caddyfile"
  put caddy/Dockerfile "$DIR/caddy/Dockerfile"
  put caddy/conf.d/crowdsec.global "$DIR/caddy/crowdsec/crowdsec.global"
  put caddy/conf.d/crowdsec.site "$DIR/caddy/crowdsec/crowdsec.site"
  mkdir -p "$DIR/caddy/conf.d"
  if [ -n "$EMAIL" ]; then printf '# Written by install.sh\nemail %s\n' "$EMAIL" | write_if_changed "$DIR/caddy/conf.d/acme.global"
  else rm_changed "$DIR/caddy/conf.d/acme.global"; fi
  if [ "${LE_STAGING:-}" = 1 ]; then printf '# Written by install.sh (--staging)\nacme_ca https://acme-staging-v02.api.letsencrypt.org/directory\n' | write_if_changed "$DIR/caddy/conf.d/staging.global"
  else rm_changed "$DIR/caddy/conf.d/staging.global"; fi
  caddy_bouncer_snippets "$( [ "$CADDY_BOUNCER" = yes ] && [ -n "$BOUNCER_KEY" ] && echo on || echo off )"

  put nginx/mediamax-common.conf "$DIR/nginx/templates/00-mediamax-common.conf.template"
  if [ -n "$DOMAIN" ]; then put nginx/mediamax.conf "$DIR/nginx/templates/default.conf.template"
  else put nginx/mediamax-http.conf "$DIR/nginx/templates/default.conf.template"; fi
  put nginx/snippets/mediamax-locations.conf "$DIR/nginx/snippets/mediamax-locations.conf"
  put nginx/40-mediamax-maintenance.sh "$DIR/nginx/40-mediamax-maintenance.sh"
  chmod 755 "$DIR/nginx/40-mediamax-maintenance.sh"
  # Reference copies for an existing proxy.
  put nginx/mediamax-common.conf "$DIR/snippets/nginx/mediamax-common.conf"
  put nginx/mediamax.conf "$DIR/snippets/nginx/mediamax.conf"
  put nginx/snippets/mediamax-locations.conf "$DIR/snippets/nginx/mediamax-locations.conf"

  # Security
  put crowdsec/acquis.yaml "$DIR/crowdsec/acquis.yaml"
  put crowdsec/parsers/s01-parse/mediamax-logs.yaml "$DIR/crowdsec/parsers/s01-parse/mediamax-logs.yaml"
  put crowdsec/scenarios/mediamax-bf.yaml "$DIR/crowdsec/scenarios/mediamax-bf.yaml"
  put fail2ban/filter.d/mediamax.conf "$DIR/fail2ban/filter.d/mediamax.conf"
  put fail2ban/filter.d/mediamax-caddy.conf "$DIR/fail2ban/filter.d/mediamax-caddy.conf"
  put fail2ban/filter.d/mediamax-nginx.conf "$DIR/fail2ban/filter.d/mediamax-nginx.conf"
  put fail2ban/jail.d/mediamax.local "$DIR/fail2ban/jail.d/mediamax.local"
  # Never ban the Docker network itself: requests that Docker's userland proxy forwards (IPv6 clients to an
  # IPv4-only network, connections from the host) arrive from its gateway, and banning that would lock out
  # everyone who comes that way.
  write_if_changed "$DIR/fail2ban/jail.d/mediamax.network.local" <<EOF
# Written by install.sh (rewritten on every run; read after mediamax.local). Your own overrides go in a
# file sorting later, e.g. jail.d/zz-custom.local.
[mediamax]
ignoreip = 127.0.0.1/8 ::1 $SUBNET

[mediamax-caddy]
ignoreip = 127.0.0.1/8 ::1 $SUBNET

[mediamax-nginx]
ignoreip = 127.0.0.1/8 ::1 $SUBNET
EOF

  write_env
  write_compose
  dc config -q || die "the generated docker-compose.yml is invalid (please report this); see $DIR"
  ok "configuration written"
}

caddy_bouncer_snippets() {
  if [ "$1" = on ]; then
    write_if_changed "$DIR/caddy/conf.d/crowdsec.global" <"$DIR/caddy/crowdsec/crowdsec.global"
    write_if_changed "$DIR/caddy/conf.d/crowdsec.site" <"$DIR/caddy/crowdsec/crowdsec.site"
  else
    rm_changed "$DIR/caddy/conf.d/crowdsec.global"
    rm_changed "$DIR/caddy/conf.d/crowdsec.site"
  fi
}
rm_changed() { [ -e "$1" ] || return 0; rm -f "$1"; CHANGED="$CHANGED ${1#"$DIR"/}"; }

# After "docker compose up": services whose mounted files changed but whose container wasn't recreated.
apply_changes() {
  local svc
  for svc in caddy nginx crowdsec fail2ban; do
    case "$CHANGED" in *" $svc/"*) ;; *) continue ;; esac
    [ "$(container_state "mediamax-$svc")" = missing ] && continue
    if [ "$svc" = caddy ] && docker exec mediamax-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      ok "Caddy reloaded with the new configuration"; continue
    fi
    info "Restarting $svc (configuration changed)"
    dc restart "$svc" >/dev/null 2>&1 || warn "could not restart $svc"
  done
  CHANGED=""
}

# ------------------------------------------------------------------------------------------- certificates
le_live() { printf '%s/letsencrypt/live/%s' "$DIR" "$DOMAIN"; }

# nginx won't start without the certificate files, and certbot needs nginx to answer the challenge: start
# with a throw-away self-signed certificate, then replace it.
nginx_dummy_cert() {
  [ "$PROXY" = nginx ] && [ -n "$DOMAIN" ] || return 0
  local live; live="$(le_live)"
  [ -f "$live/fullchain.pem" ] && return 0
  info "Creating a temporary certificate so nginx can start"
  mkdir -p "$live" "$DIR/certbot-www"
  dc run --rm --no-deps --entrypoint openssl certbot req -x509 -nodes -newkey rsa:2048 -days 2 \
    -keyout "/etc/letsencrypt/live/$DOMAIN/privkey.pem" -out "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
    -subj "/CN=$DOMAIN" >/dev/null 2>&1 || die "could not create the temporary certificate"
  touch "$live/.mediamax-temporary"
}

nginx_real_cert() {
  [ "$PROXY" = nginx ] && [ -n "$DOMAIN" ] || return 0
  local live; live="$(le_live)"
  [ -f "$live/.mediamax-temporary" ] || return 0
  info "Requesting a Let's Encrypt certificate for $DOMAIN"
  rm -rf "$live" "$DIR/letsencrypt/archive/$DOMAIN" "$DIR/letsencrypt/renewal/$DOMAIN.conf"
  local args=(certonly --webroot -w /var/www/certbot -d "$DOMAIN" --agree-tos --non-interactive --no-eff-email)
  if [ -n "$EMAIL" ]; then args+=(--email "$EMAIL"); else args+=(--register-unsafely-without-email); fi
  [ "${LE_STAGING:-}" = 1 ] && args+=(--staging)
  if dc run --rm --no-deps --entrypoint certbot certbot "${args[@]}"; then
    dc exec -T nginx nginx -s reload >/dev/null
    ok "certificate installed (renewed automatically by the certbot container)"
  else
    warn "Let's Encrypt refused the certificate. Check that $DOMAIN points at this server and that port 80 is"
    warn "reachable from the internet, then run the installer again. nginx keeps a temporary certificate."
    nginx_dummy_cert
    dc exec -T nginx nginx -s reload >/dev/null 2>&1 || true
  fi
}

# --------------------------------------------------------------------------------------------- crowdsec
cscli() { docker exec mediamax-crowdsec cscli "$@"; }

crowdsec_bouncer_key() { # NAME -> prints a new key, replacing any old registration of that name
  cscli bouncers delete "$1" >/dev/null 2>&1 || true
  cscli bouncers add "$1" -o raw 2>/dev/null | tr -d '[:space:]'
}

setup_caddy_bouncer() {
  [ "$CADDY_BOUNCER" = yes ] || return 0
  info "Waiting for CrowdSec"
  wait_healthy mediamax-crowdsec 240 || { warn "CrowdSec isn't healthy yet (docker logs mediamax-crowdsec); run the installer again later to connect Caddy to it"; return 0; }
  if [ -n "$BOUNCER_KEY" ] && cscli bouncers list -o json 2>/dev/null | grep -q '"mediamax-caddy"'; then
    caddy_bouncer_snippets on
    apply_changes
    return 0
  fi
  local key; key="$(crowdsec_bouncer_key mediamax-caddy)"
  [ -n "$key" ] || { warn "could not create the CrowdSec bouncer key; Caddy runs without the bouncer"; return 0; }
  BOUNCER_KEY="$key"
  env_set CROWDSEC_BOUNCER_KEY "$key"
  caddy_bouncer_snippets on
  info "Restarting Caddy with the CrowdSec bouncer"
  dc up -d --force-recreate caddy
  CHANGED=""
  ok "CrowdSec bouncer connected to Caddy"
}

setup_firewall_bouncer() {
  [ "$FIREWALL_BOUNCER" = yes ] || return 0
  wait_healthy mediamax-crowdsec 240 || { warn "CrowdSec isn't healthy; skipping the firewall bouncer"; return 0; }
  if ! command -v crowdsec-firewall-bouncer >/dev/null 2>&1; then
    local pm=""
    command -v apt-get >/dev/null 2>&1 && pm="apt-get"
    [ -z "$pm" ] && command -v dnf >/dev/null 2>&1 && pm="dnf"
    [ -z "$pm" ] && command -v yum >/dev/null 2>&1 && pm="yum"
    [ -n "$pm" ] || { warn "no apt/dnf/yum: install crowdsec-firewall-bouncer yourself (docs/DEPLOY.md)"; return 0; }
    info "Installing the CrowdSec firewall bouncer (repository from https://install.crowdsec.net)"
    curl -fsSL https://install.crowdsec.net | sh || { warn "adding the CrowdSec repository failed"; return 0; }
    "$pm" install -y crowdsec-firewall-bouncer-iptables || { warn "installing crowdsec-firewall-bouncer-iptables failed"; return 0; }
  fi
  local conf=/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml
  if [ ! -f "$conf.local" ] || ! grep -q "127.0.0.1:$LAPI_PORT" "$conf.local" || ! cscli bouncers list -o json 2>/dev/null | grep -q '"mediamax-firewall"'; then
    local key; key="$(crowdsec_bouncer_key mediamax-firewall)"
    [ -n "$key" ] || { warn "could not create the firewall bouncer key"; return 0; }
    mkdir -p /etc/crowdsec/bouncers
    umask 077
    cat >"$conf.local" <<EOF
# Written by MediaMax install.sh: connect to the CrowdSec container and also block in DOCKER-USER, because
# Docker-published ports bypass the INPUT chain.
api_url: http://127.0.0.1:$LAPI_PORT/
api_key: $key
iptables_chains:
  - INPUT
  - DOCKER-USER
EOF
    umask 022
  fi
  systemctl enable crowdsec-firewall-bouncer >/dev/null 2>&1 || true
  if systemctl restart crowdsec-firewall-bouncer; then ok "CrowdSec firewall bouncer running"
  else warn "crowdsec-firewall-bouncer didn't start (journalctl -u crowdsec-firewall-bouncer)"; fi
}

# ------------------------------------------------------------------------------------------------- cron
CRON_FILE=/etc/cron.d/mediamax-upgrade
setup_cron() {
  if [ "$AUTO_UPGRADE" = yes ] && [ -d /etc/cron.d ]; then
    cat >"$CRON_FILE" <<EOF
# MediaMax weekly upgrade (deploy/install.sh). Remove this file, or re-run the installer, to stop it.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * 0 root $DIR/install.sh --dir $DIR --upgrade --yes >>$DIR/logs/upgrade.log 2>&1
EOF
    chmod 644 "$CRON_FILE"
  elif [ "$AUTO_UPGRADE" = yes ]; then
    warn "no /etc/cron.d here; schedule '$DIR/install.sh --upgrade --yes' yourself"
  else
    rm -f "$CRON_FILE"
  fi
}

# ----------------------------------------------------------------------------------------------- start
check_conflicts() {
  local other
  other="$(docker ps -a --filter name='^mediamax$' --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true)"
  if [ -n "$(docker ps -a -q --filter name='^mediamax$' 2>/dev/null)" ] && [ "$other" != mediamax ]; then
    die "a container named 'mediamax' already exists (not from this installer). Stop and remove it first
       (docker stop mediamax && docker rm mediamax); point the installer's folders at its data if you want to keep it:
       copy its /config folder to $DIR/config before running the installer."
  fi
  if [ -z "$(dc_ps_quiet)" ]; then
    local p ports=""
    case "$PROXY" in
      caddy|nginx) if [ -n "$DOMAIN" ]; then ports="80 443"; else ports="$HTTP_PORT"; fi ;;
      none|existing) ports="$HTTP_PORT" ;;
    esac
    [ -n "$BIND" ] && case " $ports " in *" $HTTP_PORT "*) ;; *) ports="$ports $HTTP_PORT" ;; esac
    for p in $ports; do port_busy "$p" && warn "port $p is already in use on this host (ss -ltnp 'sport = :$p'); starting may fail"; done
  fi
  return 0
}

start_stack() {
  check_conflicts
  if [ "$NO_PULL" = 0 ]; then
    info "Pulling images"
    dc pull --ignore-buildable --quiet || warn "some images could not be pulled; using local ones"
  fi
  if [ "$CADDY_BOUNCER" = yes ]; then
    if [ "$NO_PULL" = 1 ] && docker image inspect mediamax-caddy:crowdsec >/dev/null 2>&1; then
      info "Using the existing Caddy + CrowdSec image (--no-pull)"
    else
      info "Building Caddy with the CrowdSec bouncer (a few minutes the first time)"
      if [ "$NO_PULL" = 0 ]; then dc build --pull caddy; else dc build caddy; fi
    fi
  fi
  nginx_dummy_cert
  info "Starting MediaMax"
  dc up -d --remove-orphans || die "starting the containers failed (see the message above); fix it and run the installer again"
  apply_changes
  info "Waiting for MediaMax to answer /health"
  if wait_healthy mediamax 240; then ok "MediaMax is up"
  else
    warn "MediaMax didn't report healthy in time. Recent log lines:"
    docker logs --tail 30 mediamax 2>&1 | sed 's/^/    /' >&2 || true
    die "see 'docker logs mediamax'; fix the cause and run the installer again (your answers are kept)"
  fi
  nginx_real_cert
  setup_caddy_bouncer
  setup_firewall_bouncer
  if [ "$PROXY" = caddy ] || [ "$PROXY" = nginx ]; then
    local proxy="mediamax-$PROXY"
    if wait_healthy "$proxy" 120; then ok "$PROXY is up"; else warn "$PROXY isn't healthy: docker logs $proxy"; fi
  fi
  if has_fail2ban; then
    sleep 3
    if docker exec mediamax-fail2ban fail2ban-client status mediamax >/dev/null 2>&1; then ok "fail2ban jail 'mediamax' active"
    else warn "fail2ban jail not active yet: docker logs mediamax-fail2ban"; fi
  fi
}

print_existing_proxy_help() {
  [ "$PROXY" = existing ] || return 0
  local up="127.0.0.1:$HTTP_PORT"
  [ -n "$PROXY_IP" ] && up="$(primary_ip):$HTTP_PORT"
  cat <<EOF

${C_B}Point your reverse proxy at http://$up${C_0} (or http://mediamax:8484 from a container on the
Docker network "mediamax"). It must pass WebSockets, not buffer responses, allow 64 MB uploads and keep
long-lived streams open. Ready-made settings:

  nginx                 $DIR/snippets/nginx/ (mediamax-common.conf in http {}, then
                        include mediamax-locations.conf in your server {}; set the upstream to $up)
  Caddy                 reverse_proxy $up { flush_interval -1 }
  Nginx Proxy Manager   Proxy host → http://$(primary_ip) port $HTTP_PORT, tick "Websockets Support",
                        Advanced tab: proxy_buffering off; proxy_request_buffering off;
                        client_max_body_size 64m; proxy_read_timeout 1h;
  Traefik               labels: see docs/DEPLOY.md ("Existing reverse proxy")

MediaMax believes X-Forwarded-For only from: $TRUSTED
(change MEDIAMAX_TRUSTED_PROXIES in $DIR/.env if your proxy connects from elsewhere, then: docker compose up -d)
EOF
}

print_done() {
  local url; url="$(public_url)"
  cat <<EOF

${C_G}${C_B}MediaMax is running.${C_0}

  Open:  ${C_B}$url${C_0}
         and create the first administrator in the setup wizard. Do this now: until then, anyone who
         reaches the page can claim the server.
EOF
  if [ "$PROXY" = caddy ] && [ -n "$DOMAIN" ]; then
    say "         (Caddy fetches the certificate on the first visit; give it a few seconds.)"
  fi
  print_existing_proxy_help
  cat <<EOF

Next steps
  - Add libraries using the paths inside the container: $(if [ -n "$MEDIA" ]; then printf '%s' "$MEDIA" | tr '|' '\n' | cut -d: -f2 | paste -sd' ' -; else printf '/media/... (re-run the installer to mount folders)'; fi)
  - Backups: Admin → Backups (stored in $DIR/config/backups; copy them off this machine regularly).
  - Status:     sudo $DIR/install.sh --status
  - Upgrade:    sudo $DIR/install.sh --upgrade$( [ "$AUTO_UPGRADE" = yes ] && printf '   (also every Sunday 04:17 via %s)' "$CRON_FILE")
  - Reconfigure: sudo $DIR/install.sh
  - Logs:       cd $DIR && docker compose logs -f mediamax
EOF
  if [ "$PROXY" = none ] && [ -z "$DOMAIN" ]; then
    say "  - Before exposing MediaMax to the internet, re-run the installer with a domain to get HTTPS."
  fi
  if has_crowdsec && [ "$CADDY_BOUNCER" = no ] && [ "$FIREWALL_BOUNCER" != yes ]; then
    say "  - CrowdSec detects attacks but nothing blocks them yet: install a bouncer (docs/DEPLOY.md, CrowdSec)"
    say "    or re-run the installer with --firewall-bouncer."
  fi
  say ""
}

# ----------------------------------------------------------------------------------------------- actions
load_existing_or_die() {
  [ -f "$ENV_FILE" ] && [ -f "$DIR/docker-compose.yml" ] || die "no MediaMax install in $DIR (use --dir, or run the installer without --upgrade/--status)"
}

load_settings_quietly() {
  DOMAIN="$(env_get MEDIAMAX_DOMAIN)"; EMAIL="$(env_get ACME_EMAIL)"; PROXY="$(env_get MEDIAMAX_PROXY)"
  SECURITY="$(env_get MEDIAMAX_SECURITY)"; MEDIA="$(env_get MEDIAMAX_MEDIA_DIRS)"
  PUID="$(env_get MEDIAMAX_PUID)"; PGID="$(env_get MEDIAMAX_PGID)"; TZONE="$(env_get MEDIAMAX_TZ)"
  HWACCEL="$(env_get MEDIAMAX_HWACCEL)"; TUNNEL_TOKEN="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"
  PROXY_IP="$(env_get MEDIAMAX_EXISTING_PROXY_IP)"; BIND="$(env_get MEDIAMAX_BIND)"
  IMAGE="$(env_get MEDIAMAX_IMAGE)"; FIREWALL_BOUNCER="$(env_get CROWDSEC_FIREWALL_BOUNCER)"
  AUTO_UPGRADE="$(env_get MEDIAMAX_AUTO_UPGRADE)"; LE_STAGING="$(env_get LE_STAGING)"
  HTTP_PORT="$(env_get MEDIAMAX_HTTP_PORT)"; : "${HTTP_PORT:=8484}"
  [ -n "$OPT_IMAGE" ] && IMAGE="$OPT_IMAGE"
  : "${PROXY:=none}" "${SECURITY:=none}" "${HWACCEL:=none}" "${PUID:=1000}" "${PGID:=1000}" "${TZONE:=Etc/UTC}"
  : "${IMAGE:=ghcr.io/bucifer6/mediamax:latest}" "${FIREWALL_BOUNCER:=no}" "${AUTO_UPGRADE:=no}"
  derive
}

do_install() {
  check_docker
  configure
  fetch_sources
  install_files
  setup_cron
  if [ "$NO_START" = 1 ]; then
    ok "files written to $DIR (not started: --no-start). Start with: cd $DIR && docker compose up -d"
    return 0
  fi
  start_stack
  print_done
}

do_upgrade() {
  load_existing_or_die
  check_docker
  load_settings_quietly
  info "Upgrading MediaMax in $DIR"
  fetch_sources
  install_files
  setup_cron
  [ "$NO_START" = 1 ] && { ok "files refreshed (--no-start)"; return 0; }
  start_stack
  ok "upgrade finished: $(docker inspect -f '{{.Config.Image}}{{with index .Config.Labels "org.opencontainers.image.version"}} ({{.}}){{end}}' mediamax 2>/dev/null || echo mediamax)"
  say "Old images can be removed with: docker image prune"
}

do_status() {
  load_existing_or_die
  load_settings_quietly
  say "${C_B}MediaMax in $DIR${C_0}  (proxy: $PROXY, security: $SECURITY)"
  say "Address: $(public_url)"
  say ""
  dc ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || dc ps
  say ""
  if docker exec mediamax node -e "fetch('http://127.0.0.1:8484/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok "/health answers"
  else
    warn "/health doesn't answer: docker logs mediamax"
  fi
  if [ "$PROXY" = nginx ] && [ -n "$DOMAIN" ] && [ -f "$(le_live)/fullchain.pem" ] && command -v openssl >/dev/null 2>&1; then
    say "Certificate: $(openssl x509 -in "$(le_live)/fullchain.pem" -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')"
  fi
  if has_crowdsec && [ "$(container_state mediamax-crowdsec)" = healthy ]; then
    say ""; say "${C_B}CrowdSec bans${C_0} (cscli decisions list):"
    cscli decisions list 2>/dev/null | sed 's/^/  /' || true
    say "${C_B}CrowdSec bouncers${C_0}:"
    cscli bouncers list 2>/dev/null | sed 's/^/  /' || true
  fi
  if has_fail2ban && [ "$(container_state mediamax-fail2ban)" = running ]; then
    say ""; say "${C_B}fail2ban${C_0}:"
    docker exec mediamax-fail2ban fail2ban-client status mediamax 2>/dev/null | sed 's/^/  /' || true
  fi
  local log="$DIR/config/logs/security.log"
  if [ -s "$log" ]; then
    say ""; say "${C_B}Last sign-in failures${C_0} ($log):"
    grep -E ' (AUTH_FAIL|AUTH_LOCKED) ' "$log" | tail -n 10 | sed 's/^/  /' || say "  none"
  fi
  if [ -f "$CRON_FILE" ]; then say ""; say "Auto-upgrade: on ($CRON_FILE)"; fi
}

do_uninstall() {
  load_existing_or_die
  load_settings_quietly
  if [ "$PURGE" = 1 ]; then
    warn "This deletes $DIR completely: database, artwork, backups, DVR recordings, certificates, logs."
    if interactive; then
      local typed; ask typed "Type the folder name '$DIR' to confirm" ""
      [ "$typed" = "$DIR" ] || die "not confirmed; nothing was deleted"
    elif [ "$ASSUME_YES" != 1 ]; then
      die "--purge without a terminal needs --yes"
    fi
  else
    confirm "Stop and remove the MediaMax containers? Your data in $DIR stays." y || die "cancelled"
  fi
  info "Stopping MediaMax"
  if [ "$PURGE" = 1 ]; then dc down --remove-orphans --volumes || true
  else dc down --remove-orphans || true; fi
  docker image rm mediamax-caddy:crowdsec >/dev/null 2>&1 || true
  rm -f "$CRON_FILE"
  if [ -f /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml.local ] && grep -q "MediaMax install.sh" /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml.local; then
    systemctl stop crowdsec-firewall-bouncer >/dev/null 2>&1 || true
    rm -f /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml.local
    warn "the CrowdSec firewall bouncer package is still installed; remove it with your package manager (crowdsec-firewall-bouncer-iptables)"
  fi
  if [ "$PURGE" = 1 ]; then
    case "$DIR" in /|/opt|/srv|/home|/root|/var|/usr|/etc) die "refusing to delete $DIR" ;; esac
    rm -rf "$DIR"
    ok "MediaMax removed, including its data"
  else
    ok "MediaMax stopped and removed. Data kept in $DIR (config/, recordings/). Reinstall: sudo $DIR/install.sh"
  fi
}

main() {
  case "$ACTION" in
    install) do_install ;;
    upgrade) do_upgrade ;;
    status) do_status ;;
    uninstall) do_uninstall ;;
  esac
}

main
