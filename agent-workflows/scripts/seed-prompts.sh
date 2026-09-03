#!/usr/bin/env bash
# Seed private/ prompts from examples if missing (does not overwrite).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/prompts.example/daily_site_report"
DST="$ROOT/private/daily_site_report"
mkdir -p "$DST"
for f in classifier_prompt.txt extractor_prompt.txt; do
  if [[ ! -f "$DST/$f" ]]; then
    cp "$SRC/$f" "$DST/$f"
    echo "created $DST/$f — replace with confidential company prompt"
  else
    echo "keep existing $DST/$f"
  fi
done
