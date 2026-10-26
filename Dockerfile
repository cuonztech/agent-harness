# Agent-Harness als Container: gleiche Umgebung bei jedem Lauf, ohne Node-Installation.
#
#   docker build -t cuonztech-agent-harness .
#   docker run --rm cuonztech-agent-harness                      # Hilfe
#   docker run --rm -v "$PWD":/work cuonztech-agent-harness \
#     doctor --upstream-command node --upstream-arg /app/examples/testsystem/server.mjs
#
# Eigene Dateien (Server, Report) liegen unter /work, dem eingehängten Ordner.
# Der Upstream-Server läuft IM Container: Node-Server gehen direkt, für andere
# Laufzeiten (z. B. Python) braucht es ein eigenes Image.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    TESTSYSTEM_DATA=/tmp/testsystem-bookings.json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY examples ./examples
RUN mkdir /work && chown node:node /work
USER node
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--help"]
