#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
vault_path="${1:-$plugin_root/../testvault}"

if [[ ! -d "$vault_path/.obsidian" ]]; then
  printf 'Not an Obsidian vault: %s\n' "$vault_path" >&2
  exit 1
fi

target_dir="$vault_path/.obsidian/plugins/sync-and-mcp"
cd "$plugin_root"
if [[ ! -d node_modules ]]; then
  npm ci
fi
npm run build
mkdir -p "$target_dir"
install -m 644 main.js manifest.json styles.css "$target_dir/"
for artifact in main.js manifest.json styles.css; do
  cmp "$artifact" "$target_dir/$artifact"
done
printf 'Installed and verified Sync and MCP in %s\n' "$target_dir"
