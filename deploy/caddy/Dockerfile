# Caddy with the CrowdSec bouncer module (github.com/hslatman/caddy-crowdsec-bouncer), built with xcaddy.
# The installer builds this image only when you pick Caddy + CrowdSec (`docker compose build caddy`), and
# rebuilds it on `install.sh --upgrade`.
# Pin versions with build args, e.g.  --build-arg CADDY_VERSION=2.11 --build-arg BOUNCER_VERSION=v0.15.0
ARG CADDY_VERSION=2

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG BOUNCER_VERSION=latest
# Let Go fetch a newer toolchain if the module needs one (the builder image pins GOTOOLCHAIN=local).
ENV GOTOOLCHAIN=auto
RUN xcaddy build \
      --with github.com/hslatman/caddy-crowdsec-bouncer/http@${BOUNCER_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Fail the build early if the module is missing.
RUN caddy list-modules | grep -q '^http.handlers.crowdsec$'
