#!/usr/bin/env bash
# Repopulate dist/ with the 12 shippable extension files (run on Oracle after edits).
cd "$(dirname "$0")"
cp -f manifest.json background.js content.js popup.html popup.js options.html options.js ai.js utils.js icon-16.png icon-48.png icon-128.png dist/
echo "dist/ refreshed — v$(grep -oE '"version": "[0-9.]+"' manifest.json | grep -oE '[0-9.]+')"
ls dist/
