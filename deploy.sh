#!/bin/bash

set -e

REMOTE_IP="192.168.68.56"
REMOTE_USER="hamza"
REMOTE_PATH="/home/hamza/apps/cypher/"

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

# Build and run on remote server
ssh "$REMOTE_USER@$REMOTE_IP" "cd $REMOTE_PATH && docker compose up -d --build"

echo "Deploy complete"
