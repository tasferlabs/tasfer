# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for all apps
COPY apps/web/package*.json ./apps/web/
COPY apps/api/package*.json ./apps/api/
COPY apps/live/package*.json ./apps/live/

# Install dependencies for all apps
WORKDIR /app/apps/web
RUN npm ci

WORKDIR /app/apps/api
RUN npm ci

WORKDIR /app/apps/live
RUN npm ci

# Copy source code
WORKDIR /app
COPY apps/web ./apps/web
COPY apps/api ./apps/api
COPY apps/live ./apps/live
COPY version.json ./version.json

# Build all apps
WORKDIR /app/apps/web
RUN npm run build

WORKDIR /app/apps/api
RUN npm run build

WORKDIR /app/apps/live
RUN npm run build

# Production stage
FROM node:22-alpine AS runner

# Install tini for proper signal handling
RUN apk add --no-cache tini

WORKDIR /app

# Install production dependencies for all apps
COPY apps/web/package*.json ./apps/web/
COPY apps/api/package*.json ./apps/api/
COPY apps/live/package*.json ./apps/live/

WORKDIR /app/apps/web
RUN npm ci --omit=dev

WORKDIR /app/apps/api
RUN npm ci --omit=dev

WORKDIR /app/apps/live
RUN npm ci --omit=dev

# Copy built artifacts
WORKDIR /app
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/web/server.js ./apps/web/server.js
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/live/dist ./apps/live/dist
COPY --from=builder /app/version.json ./version.json

# Create startup script - tini handles signal forwarding to all children
RUN cat > /app/start.sh << 'EOF'
#!/bin/sh

# Run database migrations
echo "[startup] Running database migrations..."
cd /app/apps/api && node dist/db/migrate.js

# Start API server in background
echo "[startup] Starting API server..."
cd /app/apps/api && PORT=3000 node dist/index.js &

# Start Live server in background
echo "[startup] Starting Live server..."
cd /app/apps/live && PORT=8080 node dist/server.js &

# Wait for API server to be ready
echo "[startup] Waiting for API server to be ready..."
for i in $(seq 1 30); do
  if wget -q --spider http://localhost:3000/health 2>/dev/null; then
    echo "[startup] API server is ready"
    break
  fi
  sleep 1
done

# Start web server in foreground
echo "[startup] Starting Web server..."
cd /app/apps/web && exec node server.js
EOF
RUN chmod +x /app/start.sh

WORKDIR /app

# Expose port (api and live are proxied internally by web server)
EXPOSE 4000

# Default environment variables
ENV NODE_ENV=production
ENV PORT=4000
ENV API_URL=http://localhost:3000
ENV LIVE_URL=http://localhost:8080

# Use tini as init - it forwards SIGTERM to all child processes
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/app/start.sh"]
