# HackersDigest — Dockerfile
# Multi-stage: build the frontend with Vite, then serve with the Express API.

# ---------------------------------------------------------------
# Stage 1: frontend build
# ---------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source and build
COPY src/ ./src/
COPY vite.config.js index.html ./
RUN npm run build

# ---------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the built frontend from stage 1
COPY --from=builder /app/dist ./dist

# Copy server code and schema
COPY server/ ./server/
COPY db/ ./db/

# Environment (set at runtime via -e or .env)
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_URL=postgres://postgres:postgres@localhost:5432/hackersdigest
ENV ADMIN_HANDLE=evobugz

EXPOSE 3001

# The API binds to 0.0.0.0:SERVER_PORT and applies the schema on boot.
CMD ["node", "server/index.js"]
