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

# Build all apps
WORKDIR /app/apps/web
RUN npm run build

WORKDIR /app/apps/api
RUN npm run build

WORKDIR /app/apps/live
RUN npm run build

# Production stage
FROM node:22-alpine AS runner

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
COPY --from=builder /app/apps/web/server.ts ./apps/web/server.ts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/live/dist ./apps/live/dist

# Install tsx for the web server only
WORKDIR /app/apps/web
RUN npm install tsx

# Create startup script
WORKDIR /app
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'cd /app/apps/api && PORT=3000 node dist/index.js &' >> /app/start.sh && \
    echo 'cd /app/apps/live && PORT=8080 node dist/server.js &' >> /app/start.sh && \
    echo 'cd /app/apps/web && node --import tsx server.ts' >> /app/start.sh && \
    chmod +x /app/start.sh

WORKDIR /app

# Expose port (api and live are proxied internally by web server)
EXPOSE 4000

# Default environment variables
ENV NODE_ENV=production
ENV PORT=4000
ENV API_URL=http://localhost:3000
ENV LIVE_URL=http://localhost:8080

CMD ["/app/start.sh"]
