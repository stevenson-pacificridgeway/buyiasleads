#!/bin/bash
# Auto-deploy every hour if changes exist

while true; do
  cd ~/Desktop/BuyIASLeads
  
  # Check for uncommitted changes
  if [[ -n $(git status -s) ]]; then
    echo "✅ Changes detected - deploying..."
    git add .
    git commit -m "Auto-deployment: $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin main
    echo "✅ Deployed at $(date)"
  else
    echo "⏸️  No changes"
  fi
  
  # Wait 1 hour
  sleep 3600
done
