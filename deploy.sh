#!/bin/bash

set -e

REMOTE_IP="home-server"
REMOTE_USER="hamza"
REMOTE_PATH="/home/hamza/apps/cypher/"
STACK_NAME="cypher"

echo "Deploying to $REMOTE_USER@$REMOTE_IP:$REMOTE_PATH"

# Sync files to remote server
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.vscode' \
  --exclude '.claude' \
  --exclude '.DS_Store' \
  --exclude '*.md' \
  --exclude 'sample.json' \
  --exclude 'logo.png' \
  --exclude 'cdn' \
  --exclude 'docs' \
  --exclude 'packages' \
  --exclude 'apps/android' \
  --exclude 'apps/ios' \
  --exclude 'deploy.sh' \
  ./ "$REMOTE_USER@$REMOTE_IP:$REMOTE_PATH"

# Build and deploy on remote server
ssh "$REMOTE_USER@$REMOTE_IP" << 'ENDSSH'
set -e
cd /home/hamza/apps/cypher/

# Load environment variables from .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Generate unique tag for this deploy
TAG=$(date +%Y%m%d%H%M%S)
echo "Using image tag: $TAG"

# Build Docker images with unique tag
echo "Building images..."
docker build -f Dockerfile.web -t cypher-web:$TAG .
docker build -f Dockerfile.api -t cypher-api:$TAG .
docker build -f Dockerfile.live -t cypher-live:$TAG .

# Deploy with Nomad
echo "Deploying with Nomad..."
nomad job run \
  -var="traefik_auth=${TRAEFIK_AUTH}" \
  -var="database_url=${DATABASE_URL}" \
  -var="redis_url=${REDIS_URL}" \
  -var="image_tag=${TAG}" \
  -var="jwt_secret=${JWT_SECRET}" \
  -var="internal_api_key=${INTERNAL_API_KEY}" \
  -var="app_url=${APP_URL}" \
  -var="cors_origin=${CORS_ORIGIN}" \
  -var="mail_server_name=${MAIL_SERVER_NAME}" \
  -var="mail_port=${MAIL_PORT}" \
  -var="mail_username=${MAIL_USERNAME}" \
  -var="mail_password=${MAIL_PASSWORD}" \
  -var="mail_from=${MAIL_FROM}" \
  -var="mail_from_name=${MAIL_FROM_NAME}" \
  cypher.nomad.hcl

echo ""
echo "Job status:"
nomad job status cypher

echo ""
echo "Deploy complete"
ENDSSH
