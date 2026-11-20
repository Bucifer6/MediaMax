# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev --workspaces --include-workspace-root

# ---- runtime ----
FROM node:22-bookworm-slim
# ffmpeg with VAAPI/QSV drivers for hardware transcoding (Intel/AMD). For NVIDIA use the nvidia runtime.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
      mesa-va-drivers intel-media-va-driver-non-free i965-va-driver 2>/dev/null \
    || apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata mesa-va-drivers \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/shared/package.json shared/package.json
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web/dist
ENV NODE_ENV=production \
    MEDIAMAX_DATA=/config \
    MEDIAMAX_TRANSCODE_DIR=/transcode \
    MEDIAMAX_RECORDINGS=/recordings \
    MEDIAMAX_PORT=8484
VOLUME ["/config", "/transcode", "/recordings"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8484/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
