# ---- Base Stage ----
FROM node:22-alpine AS base
WORKDIR /usr/src/app

# ---- Dependencies Stage ----
FROM base AS deps
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY patches ./patches
COPY prisma ./prisma
RUN npm install -g pnpm
RUN pnpm install

# ---- Build Stage ----
FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm build

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV production
COPY --from=build /usr/src/app/dist ./dist
COPY --from=deps /usr/src/app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/main.js"]
