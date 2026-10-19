#!/bin/bash

set -e

# Fixed prefix: install location must not depend on the active node/nvm version
npm install -g --prefix "$HOME/.local" "$(npm pack)"

if [ "$(command -v claude-nonstop 2>/dev/null)" != "$HOME/.local/bin/claude-nonstop" ]; then
  echo "WARN: PATH resolves claude-nonstop elsewhere (is ~/.local/bin first in PATH?):" >&2
  type -a claude-nonstop >&2 || true
fi
