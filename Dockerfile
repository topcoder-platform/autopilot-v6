# ---- Base Stage ----
FROM node:20-alpine AS base
WORKDIR /usr/src/app

# ---- Dependencies Stage ----
FROM base AS deps
# Install pnpm
RUN npm install -g pnpm
# Copy dependency-defining files
COPY package.json pnpm-lock.yaml ./
# Install dependencies
RUN pnpm install --frozen-lockfile --prod

# ---- Build Stage ----
FROM base AS build
RUN npm install -g pnpm
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
# Build the application
RUN pnpm build

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV production
RUN npm install -g pnpm
# Copy built application from the build stage
COPY --from=build /usr/src/app/dist ./dist
# Copy production dependencies from the deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["pnpm", "run", "start:prod"] 