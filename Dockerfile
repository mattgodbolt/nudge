# Multi-stage: the unit tests must pass for the image to build, so a bad push never replaces a working deployment.
# better-sqlite3 compiles from source when no prebuilt binary matches, so the build stages carry a toolchain; the
# runtime image does not.
FROM node:22-bookworm-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM toolchain AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS test
COPY . .
# Fewer workers than cores: parallel file-creating tests contend badly for I/O on some storage drivers.
RUN npx vitest run --maxWorkers=2 && touch /tests-passed

FROM deps AS build
COPY . .
RUN npm run build

FROM toolchain AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NUDGE_HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/backup-db.mjs ./deploy/backup-db.mjs
# Ties this stage to the test stage so the tests always run (and gate the build).
COPY --from=test /tests-passed /tests-passed
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4517/api/bootstrap').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
