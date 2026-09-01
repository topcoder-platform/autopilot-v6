# ---- Base Stage ----
FROM alpine:3.24 AS base
RUN apk upgrade --no-cache \
  && apk add --no-cache nodejs-current=26.5.1-r0 \
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
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ---- Build Stage ----
FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm build

# ---- Production Dependencies Stage ----
FROM tooling AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm dlx prisma@6.19.3 generate --schema prisma/challenge.schema.prisma

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV=production
ENV HOME=/home/app
COPY --chown=app:app --from=build /usr/src/app/dist ./dist
COPY --chown=app:app --from=prod-deps /usr/src/app/node_modules ./node_modules
EXPOSE 3000
USER 10001:10001
CMD ["node", "dist/src/main.js"]
