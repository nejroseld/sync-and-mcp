---
name: obsi-plugin-testvault
description: Build the Sync and MCP plugin and install its release files into a local Obsidian test vault. Use when asked to compile, deploy, or refresh the plugin in testvault.
---

# Install Sync and MCP in testvault

Run `scripts/deploy.sh [vault-path]` from this skill. With no argument, the script targets `../testvault` relative to the plugin repository. It installs dependencies with `npm ci` if `node_modules` is absent, builds the production bundle, copies only `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/sync-and-mcp/`, and verifies each copied file with `cmp`.

Check that the target is the requested test vault before writing. Preserve `data.json` and all other vault files; they can contain device tokens, encryption passwords, and local notes. The script refuses a path without `.obsidian`. If the target is outside the writable workspace, request the required filesystem escalation for the install instead of changing the target or bypassing the restriction.

Report the destination and verification result. A running Obsidian instance may need a plugin reload to use the new bundle.
