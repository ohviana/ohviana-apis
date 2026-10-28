# API + outbox worker image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t ohviana-api .
# Run:
#   API:        docker run --env-file .env -p 4000:4000 ohviana-api
#   Worker:     docker run --env-file .env ohviana-api node dist/worker/main.js
#   Migrations: docker run --env-file .env ohviana-api node dist/migrate.js   (once per deploy)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace @ohviana/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN npm run build -w @ohviana/api

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/packages/contracts/package.json packages/contracts/
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/shared/package.json packages/shared/
# Runtime needs only the API's npm dependencies; workspace code is bundled into dist/.
RUN npm ci --omit=dev --workspace @ohviana/api --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/db/migrations ./migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/v1/health || exit 1
CMD ["node", "dist/server.js"]
