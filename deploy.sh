#!/bin/bash
# Deploy BuyIASLeads fixes to GitHub and Railway

cd ~/Desktop/BuyIASLeads

# Clean up git lock file if it exists
rm -f .git/index.lock

# Add documentation files
git add AUDIT_REPORT.md .env.example DEPLOYMENT_FIXES.md

# Commit
git commit -m "Docs: Add comprehensive audit report and deployment guide"

# Push to GitHub (triggers auto-deploy)
git push origin main

echo "✅ Push complete! GitHub Actions will auto-deploy in 2-5 minutes."
echo "   Monitor: https://github.com/stevenson-pacificridgeway/buyiasleads/actions"
echo "   Test: https://buyiasleads.com/checkout.html"
