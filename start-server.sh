#!/bin/sh
set -eu

# Resolve the project from this script, so any clone location works.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: Bun is required. Install it from https://bun.sh and add it to PATH." >&2
  exit 1
fi

exec bun src/server.ts
