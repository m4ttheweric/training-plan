#!/bin/zsh
export PATH="/Users/matt/.local/bin:/Users/matt/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "/Users/matt/Documents/GitHub/training-plan" || exit 1

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun not found on PATH ($PATH)." >&2
  exit 1
fi

exec env PORT=8081 bun src/server.ts
