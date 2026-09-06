#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
assetfit_node="${ASSETFIT_NODE:-}"
if [ -z "$assetfit_node" ]; then assetfit_node="$(command -v node || true)"; fi
if [ -z "$assetfit_node" ] && [ -d "$HOME/.cache" ]; then
  assetfit_node="$(find "$HOME/.cache" -maxdepth 7 -type f -path '*/dependencies/node/bin/node' -print -quit 2>/dev/null)"
fi
if [ -z "$assetfit_node" ]; then
  echo 'AssetFit needs Node.js 22.13 or newer. Install Node or set ASSETFIT_NODE to its executable.'
  exit 1
fi
"$assetfit_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))throw new Error("Node.js 22.13 or newer is required")'
if [ ! -d node_modules ] || [ ! -f dist/app.js ]; then
  echo 'Run pnpm install --frozen-lockfile and pnpm build in this directory first.'
  exit 1
fi
exec "$assetfit_node" src/cli.mjs serve "$@"
