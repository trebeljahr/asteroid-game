FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS base
WORKDIR /app

RUN npm install -g pnpm@10.33.2

COPY server/package.json server/
COPY shared/package.json shared/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
WORKDIR /app

RUN pnpm install --frozen-lockfile --filter @simple-asteroid-game/server...

COPY shared ./shared
COPY server ./server

RUN pnpm run build:server

# Production dependencies get their own stage so the install starts from an
# empty tree. Running `pnpm install --prod` on top of the full install in the
# build stage makes pnpm purge node_modules, which it refuses to do without a
# TTY (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
FROM base AS prod-deps
WORKDIR /app

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @simple-asteroid-game/server...

FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=9777

COPY --from=build /app/server/package*.json ./server/
COPY --from=build /app/server/dist ./server/dist
# Migrations are copied into dist by the build script, but keep the
# src copy around as a belt-and-suspenders fallback used by
# resolveMigrationsFolder when dist lookup fails.
COPY --from=build /app/server/src/db/migrations ./server/src/db/migrations
# pnpm keeps packages in /app/node_modules/.pnpm and links the server's direct
# dependencies from /app/server/node_modules, so both trees are needed.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/shared/package*.json ./shared/
COPY --from=build /app/package*.json ./

USER node

EXPOSE 9777

HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '9777') + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server/dist/server/src/server.js"]
