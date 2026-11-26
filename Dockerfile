# ---- Base Stage ----
ARG NODE_VERSION=26.13.1

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS base
ARG NODE_VERSION
RUN apk upgrade --no-cache \
  && apk add --no-cache 'libcrypto3>=3.5.9-r1' 'libssl3>=3.5.9-r1' 'nodejs-current~26.13.1' "zlib>=1.4-r0" \
  && test "$(node -p 'process.versions.node')" = "${NODE_VERSION}" \
  && addgroup -S -g 10001 app \
  && adduser -S -D -u 10001 -G app -h /home/app app
WORKDIR /usr/src/app

# ---- Tooling Stage ----
FROM base AS tooling
RUN apk add --no-cache npm \
  && npm install -g pnpm@11.15.1

# ---- Dependencies Stage ----
FROM tooling AS deps
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY tools ./tools
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ---- Build Stage ----
FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm lint && pnpm test --runInBand && pnpm test:dependency-compat && pnpm build

# ---- Production Dependencies Stage ----
FROM tooling AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools ./tools
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm dlx prisma@7.10.1 generate --schema prisma/challenge.schema.prisma

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV=production
ENV HOME=/home/app
COPY --chown=app:app --from=build /usr/src/app/dist ./dist
COPY --chown=app:app --from=prod-deps /usr/src/app/node_modules ./node_modules
EXPOSE 3000
USER 10001:10001
CMD ["node", "dist/src/main.js"]
