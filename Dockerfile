# ---- Base Stage ----
FROM node:22.23.1-alpine AS base
RUN apk upgrade --no-cache
WORKDIR /usr/src/app

# ---- Tooling Stage ----
FROM base AS tooling
RUN npm install -g pnpm@11.15.1

# ---- Dependencies Stage ----
FROM tooling AS deps
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY patches ./patches
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
COPY patches ./patches
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm dlx patch-package@8.0.0 \
  && pnpm dlx prisma@6.19.3 generate --schema prisma/challenge.schema.prisma

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /usr/src/app/dist ./dist
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
