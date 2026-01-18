# Getting Started

This guide covers setting up the development environment for Cypher.

## Prerequisites

- Node.js (v18+)
- Docker
- npm

## Database Setup

### PostgreSQL

Create a PostgreSQL 15 container named `cypher`:

```bash
docker run -d \
  --name cypher \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cypher \
  -p 5432:5432 \
  postgres:15
```

### Redis

Create a Redis container named `cypher-cache`:

```bash
docker run -d \
  --name cypher-cache \
  -p 6379:6379 \
  redis:latest
```

## Starting the Services

After the containers are running, start each service:

```bash
# Terminal 1 - API Server
cd apps/api
npm run db:migrate  # Run migrations first
npm run dev

# Terminal 2 - WebSocket Server
cd apps/live
npm run dev

# Terminal 3 - Web App
cd apps/web
npm run dev
```

## Verifying Setup

- Web app: http://localhost:5173
- API server: http://localhost:3000
- WebSocket server: ws://localhost:8080

## Useful Commands

```bash
# Stop containers
docker stop cypher cypher-cache

# Start containers
docker start cypher cypher-cache

# View container logs
docker logs cypher
docker logs cypher-cache

# Remove containers (data will be lost)
docker rm -f cypher cypher-cache
```
