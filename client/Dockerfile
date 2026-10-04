FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN npm install -g pnpm@10.33.2

COPY client/package.json client/
COPY shared/package.json shared/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile --filter @simple-asteroid-game/client...

COPY shared ./shared
COPY client ./client

RUN pnpm run build:client

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/client/dist ./dist
COPY --from=build /app/client/server.mjs ./server.mjs
COPY --from=build /app/client/package*.json ./

ENV NODE_ENV=production
ENV PORT=80

USER node

EXPOSE 80

HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '80') + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
