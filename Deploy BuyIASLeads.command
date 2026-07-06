#!/bin/bash
# Double-click this file to deploy BuyIASLeads.
# It always uses the correct folder, and one push updates BOTH:
#   - the website pages (GitHub Pages / frontend)
#   - the server (Railway / backend, auto-deploys from GitHub)

cd "$HOME/Desktop/BuyIASLeads" || { echo "Could not find the BuyIASLeads folder."; read -n 1; exit 1; }

echo "================================================"
echo "  Deploying BuyIASLeads (frontend + backend)"
echo "  Folder: $(pwd)"
echo "================================================"
echo

# Clear any stale git lock
rm -f .git/index.lock 2>/dev/null

# Stage and commit anything not yet committed (safe if nothing changed)
git add -A
git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')" 2>/dev/null || echo "Nothing new to commit — pushing existing commits."

echo
echo "Pushing to GitHub (this updates the site AND the server)..."
git push origin main

echo
echo "------------------------------------------------"
echo "Done. Your changes go live in about 2 minutes:"
echo "  Site:    https://buyiasleads.com"
echo "  Server:  https://buyiasleads-production.up.railway.app/health"
echo "------------------------------------------------"
echo "You can close this window."
read -n 1
