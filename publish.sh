#!/usr/bin/env bash
# Rebuild data/desk.json from the paper logs, commit it only if it changed,
# then pull --rebase and push to main using $GH_TOKEN (never stored in .git/config).
set -euo pipefail
cd "$(dirname "$0")"
[ -n "${GH_TOKEN:-}" ] || { echo "GH_TOKEN not set" >&2; exit 1; }
python3 tools/build-data.py
python3 -c "import json;json.load(open('data/desk.json'))" || { echo "invalid JSON" >&2; exit 1; }
AS_OF=$(python3 -c "import json;print(json.load(open('data/desk.json')).get('asOfET','unknown'))")
git config user.name >/dev/null || git config user.name "Randec123"
git config user.email >/dev/null || git config user.email "350354584+Randec123@users.noreply.github.com"
git add data/desk.json
if git diff --cached --quiet; then echo "No changes to data files"; exit 0; fi
git commit -q -m "Refresh Signal Desk paper-log data (as of ${AS_OF})"
AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
git -c http.extraheader="AUTHORIZATION: basic ${AUTH}" pull -q --rebase origin main
git -c http.extraheader="AUTHORIZATION: basic ${AUTH}" push -q origin HEAD:main
echo "Pushed Signal Desk data as of ${AS_OF}"
