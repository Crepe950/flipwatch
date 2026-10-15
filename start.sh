#!/usr/bin/env bash
# Start FlipWatch (after install.sh) and open it in your browser. Ctrl+C stops it.
cd "$(dirname "$0")"
url="http://127.0.0.1:3000"
(
  for _ in $(seq 1 60); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; fi
      exit 0
    fi
    sleep 1
  done
) &
exec npm run start:local
