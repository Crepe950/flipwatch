#!/usr/bin/env bash
# FlipWatch installer for macOS and Linux:   ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$1"; }

step "Checking Node.js (version 22 or newer is needed)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install the LTS version from https://nodejs.org (macOS: brew install node), then run this again."
  exit 1
fi
major="$(node --version | sed 's/^v//; s/\..*//')"
if [ "$major" -lt 22 ]; then
  echo "Node.js $(node --version) is too old. Install version 22 or newer from https://nodejs.org, then run this again."
  exit 1
fi
echo "Node.js $(node --version) found."

step "Installing FlipWatch's packages (a few minutes the first time)"
npm ci --no-audit --no-fund

step "Building FlipWatch"
npm run build

if [ ! -f .env.local ]; then
  step "Creating .env.local"
  {
    echo "# FlipWatch settings for this computer. Most settings (AI engine, Facebook, your area) are set in the app."
    echo "APP_URL=http://127.0.0.1:3000"
    echo "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
    echo "# Optional: require a password to open FlipWatch"
    echo "APP_PASSWORD="
  } > .env.local
fi

step "Starting FlipWatch"
echo "Opening http://127.0.0.1:3000 - keep this terminal open while you use FlipWatch (Ctrl+C stops it)."
exec ./start.sh
