#!/bin/sh
# Vibe container entrypoint.
#
# PUID / PGID (optional): run Vibe as that user and group instead of root, so files it writes (database,
# artwork, DVR recordings) on NAS shares get the owner you expect. Without them it runs as root, as before.
# The container can also be started with `--user uid:gid` (or `user:` in compose); then this script does nothing.
set -eu

# KINORA_<NAME> overrides the original MEDIAMAX_<NAME> (the image's defaults use the MEDIAMAX_ names). The server
# does the same itself; doing it here too makes this script's own settings follow the new names.
for kv in $(env | sed -n 's/^KINORA_\([A-Za-z0-9_]*\)=.*/\1/p'); do
  eval "export MEDIAMAX_$kv=\"\$KINORA_$kv\""
done

if [ "$(id -u)" != "0" ] || [ -z "${PUID:-}${PGID:-}" ]; then
  exec "$@"
fi

if [ -z "${PUID:-}" ] || [ -z "${PGID:-}" ]; then
  echo "vibe: set both PUID and PGID (or neither)" >&2; exit 1
fi
case "$PUID$PGID" in
  *[!0-9]*) echo "vibe: PUID and PGID must be numbers (got PUID='$PUID' PGID='$PGID')" >&2; exit 1 ;;
esac
if [ "$PUID" = "0" ] && [ "$PGID" = "0" ]; then
  exec "$@"
fi

# Writable locations Vibe owns. /config is fully Vibe's own, so it is fixed up recursively, but only
# when its top folder has a different owner (first start, or PUID changed). /transcode and /recordings only
# get their top folder changed; existing recordings and media folders are never touched.
fix_owner() {
  dir="$1"; recursive="$2"
  [ -d "$dir" ] || return 0
  [ "$(stat -c %u:%g "$dir")" = "$PUID:$PGID" ] && return 0
  if [ "$recursive" = "yes" ]; then
    chown -R "$PUID:$PGID" "$dir" 2>/dev/null || echo "vibe: could not change the owner of $dir (read-only or NFS root squash?)" >&2
  else
    chown "$PUID:$PGID" "$dir" 2>/dev/null || echo "vibe: could not change the owner of $dir" >&2
  fi
}
fix_owner "${MEDIAMAX_DATA:-/config}" yes
fix_owner "${MEDIAMAX_TRANSCODE_DIR:-/transcode}" no
fix_owner "${MEDIAMAX_RECORDINGS:-/recordings}" no

# Hardware transcoding: join the groups that own the GPU device nodes (render/video), whatever their ids are
# on this host. MEDIAMAX_EXTRA_GIDS adds more (comma separated), e.g. a NAS group that may read the media.
groups="$PGID"
for dev in /dev/dri/renderD* /dev/dri/card* /dev/nvidia0; do
  [ -e "$dev" ] && groups="$groups,$(stat -c %g "$dev")"
done
if [ -n "${MEDIAMAX_EXTRA_GIDS:-}" ]; then
  case "$MEDIAMAX_EXTRA_GIDS" in
    *[!0-9,]*) echo "vibe: MEDIAMAX_EXTRA_GIDS must be numbers separated by commas" >&2; exit 1 ;;
  esac
  groups="$groups,$MEDIAMAX_EXTRA_GIDS"
fi
groups="$(printf '%s' "$groups" | tr ',' '\n' | grep -v '^$' | sort -un | paste -sd, -)"

export HOME="${MEDIAMAX_DATA:-/config}"
exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$groups" --inh-caps=-all -- "$@"
