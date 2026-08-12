# ============================================================================
# CI-Docker-Image des easycompliance-MCP-Servers (Variante C in
# deploy/DEPLOYMENT.md: fertiges Image von Docker Hub, Betrieb komplett
# ueber die Plesk-Docker-GUI ohne Shell-Zugriff).
#
# Wird von .github/workflows/docker-publish.yml AUS DEM QUELLCODE gebaut
# (Multi-Stage: Build + schlankes Runtime-Image) - bewusst unabhaengig von
# der npm-Registry, damit Release-Tag und Image-Inhalt immer zusammenpassen.
# Wer stattdessen selbst aus dem npm-Paket baut (Variante B), nutzt
# deploy/Dockerfile.example.
# ============================================================================

# ── Build-Stage: TypeScript kompilieren, Dev-Dependencies entfernen ─────────
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

# ── Runtime-Stage: nur dist/ + Produktions-Dependencies ─────────────────────
FROM node:22-alpine
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
# package.json liegt eine Ebene ueber dist/ - packageVersion() liest sie zur
# Laufzeit fuer die serverInfo-Version.
COPY --from=build /build/package.json ./package.json

# Container-intern MUSS der Prozess an 0.0.0.0 binden, sonst erreicht das
# Docker-Port-Mapping ihn nicht. Nach aussen bleibt der Dienst lokal, wenn
# der HOST-Port an 127.0.0.1 gebunden wird (DEPLOYMENT.md, Varianten B/C).
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8765
EXPOSE 8765

# Unprivilegierter Nutzer (im offiziellen node-Image bereits vorhanden).
USER node

# Supervision: Docker-Healthcheck gegen den /healthz-Endpoint (busybox-wget).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8765/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "dist/http.js"]
