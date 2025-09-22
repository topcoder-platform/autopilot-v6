# ---- Base Stage ----
FROM node:20-bookworm AS base
WORKDIR /usr/src/app

# ---- Dependencies Stage ----
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    librdkafka-dev \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod

# ---- Build Stage ----
FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm build

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV production
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    librdkafka1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/src/app/dist ./dist
COPY --from=deps /usr/src/app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/main.js"]
