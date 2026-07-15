#!/usr/bin/env bash
# ============================================================
# One-shot deploy of the Commodity Carry Monitor backend to an
# existing Supabase project, using the Supabase CLI.
#
# Prereqs: npm i -g supabase && supabase login
# Usage:   ./deploy.sh <project-ref>
#          e.g. ./deploy.sh whuuytqvucbtzsraxgfh
# ============================================================
set -euo pipefail

REF="${1:?Usage: ./deploy.sh <project-ref>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Applying database schema"
supabase db execute --project-ref "$REF" --file "$HERE/supabase/migrations/001_carry_schema.sql"

echo "==> Deploying edge function"
cd "$HERE/supabase"
supabase functions deploy carry-daily-update --project-ref "$REF"

echo "==> Done. Two manual steps remain:"
echo "  1. Run supabase/schedule.sql in the SQL editor (fill in project ref + anon key)"
echo "  2. Put your project URL + anon key into commodity-carry-monitor.html (CONFIG block at top)"
