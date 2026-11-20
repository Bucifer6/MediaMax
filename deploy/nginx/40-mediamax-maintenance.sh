#!/bin/sh
# Runs inside the nginx container at start (mounted into /docker-entrypoint.d/ by the generated
# docker-compose.yml). Every 6 hours, in the background:
#   - rotate the access/error logs in /var/log/nginx when they pass 50 MB (one old copy, .1), because the
#     logs live on the host (for CrowdSec and fail2ban) and the official image has no logrotate;
#   - reload nginx, so certificates renewed by the certbot container are picked up.
set -eu
(
  while :; do
    sleep 21600
    rotated=0
    for f in /var/log/nginx/mediamax.access.log /var/log/nginx/access.log /var/log/nginx/error.log; do
      if [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 52428800 ]; then
        mv -f "$f" "$f.1"; rotated=1
      fi
    done
    [ "$rotated" = 1 ] && nginx -s reopen 2>/dev/null || true
    nginx -s reload 2>/dev/null || true
  done
) >/dev/null 2>&1 &
