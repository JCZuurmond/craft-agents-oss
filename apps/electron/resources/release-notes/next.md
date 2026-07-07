# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Plugin framework**: extend Craft Agents without modifying core. Plugins declare permissions and contributions in a manifest — side panels on any shell edge (left/right/top/bottom), commands with keybindings — and are managed from the new **Settings → Plugins** page (live enable/disable, per-plugin status). External plugins drop into `~/.craft-agent/plugins/<id>/` and load from disk behind a trust prompt, no rebuild needed; scaffold one with `bun run plugin:new <id>` and check it with `bun run plugin:validate <dir>`. See `docs/plugins/` for the authoring guide and security model.

## Improvements

## Bug Fixes

## Breaking Changes
