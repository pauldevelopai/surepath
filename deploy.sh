#!/bin/bash
# Surepath V1 — Lightsail deployment script
# Run this ON the server: ssh ubuntu@3.10.232.143 then paste this

set -e

echo "=== SUREPATH DEPLOYMENT ==="
echo ""

# ─── 1. System updates ───────────────────────────────────────────────
echo "[1/7] System updates..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential nginx certbot python3-certbot-nginx

# ─── 2. Node.js 22 ───────────────────────────────────────────────────
echo "[2/7] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
echo "Node: $(node -v) | npm: $(npm -v)"

# ─── 3. PostgreSQL 16 ────────────────────────────────────────────────
echo "[3/7] Installing PostgreSQL 16..."
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Create surepath database and user
sudo -u postgres psql -c "CREATE USER surepath WITH PASSWORD 'surepath2025';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE surepath OWNER surepath;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE surepath TO surepath;" 2>/dev/null || true
echo "PostgreSQL ready"

# ─── 4. Chromium for Puppeteer ────────────────────────────────────────
echo "[4/7] Installing Chromium for Puppeteer..."
sudo apt install -y chromium-browser fonts-liberation libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libcups2 libpango-1.0-0 libcairo2 libasound2t64
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
echo "Chromium: $(chromium-browser --version 2>/dev/null || echo 'installed')"

# ─── 5. PM2 process manager ──────────────────────────────────────────
echo "[5/7] Installing PM2..."
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true

# ─── 6. App directory ────────────────────────────────────────────────
echo "[6/7] Setting up app directory..."
sudo mkdir -p /var/www/surepath
sudo chown ubuntu:ubuntu /var/www/surepath

echo ""
echo "[7/7] System ready! Next steps:"
echo ""
echo "  1. Copy your code to the server:"
echo "     rsync -avz --exclude node_modules --exclude .next --exclude .git \\"
echo "       -e 'ssh -i ~/path/to/LightsailDefaultKey.pem' \\"
echo "       /path/to/surepath/ ubuntu@3.10.232.143:/var/www/surepath/"
echo ""
echo "  2. SSH in and set up the app:"
echo "     ssh -i ~/path/to/LightsailDefaultKey.pem ubuntu@3.10.232.143"
echo "     cd /var/www/surepath"
echo "     npm install"
echo "     cd dashboard && npm install && npm run build && cd .."
echo ""
echo "  3. Create .env file (copy from dev and update):"
echo "     - DATABASE_URL=postgresql://surepath:surepath2025@localhost:5432/surepath"
echo "     - SERVER_HOST=surepath.co.za"
echo "     - PAYMENT_ENABLED=true"
echo ""
echo "  4. Run the schema:"
echo "     psql -U surepath -d surepath -f schema.sql"
echo "     psql -U surepath -d surepath -f schema-security.sql"
echo ""
echo "  5. Start with PM2:"
echo "     PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser pm2 start server.js --name surepath"
echo "     pm2 start 'cd dashboard && npm start' --name dashboard"
echo "     pm2 save"
echo ""
echo "=== DONE ==="
