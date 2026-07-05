#!/bin/bash
# BuyIASLeads — single deploy command.
#
# Pushing to GitHub main does two things at once:
#   1. Updates the website on GitHub Pages (index.html, checkout.html, etc.)
#   2. Triggers Railway to redeploy the backend (server.js) via its GitHub integration
#
# Usage:  double-click this file, or run:  bash deploy.sh

set -e
cd "$(dirname "$0")"

# Clear any stale git lock
rm -f .git/index.lock 2>/dev/null || true

echo "Staging all changes..."
git add -A

if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')"
fi

echo "Pushing to GitHub (updates the site + backend)..."
git push origin main

echo ""
echo "Done. Live in ~2-5 minutes:"
echo "  Site:     https://buyiasleads.com/checkout.html"
echo "  Backend:  https://buyiasleads-production.up.railway.app/health"
echo ""
echo "Test with the \$1.00 TEST package before running a real card."
