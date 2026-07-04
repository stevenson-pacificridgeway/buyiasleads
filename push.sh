#!/bin/bash
cd ~/Desktop/BuyIASLeads

# Check if GitHub SSH key exists
if [ -f ~/.ssh/id_rsa ]; then
    # Use SSH instead of HTTPS
    git remote set-url origin git@github.com:stevenson-pacificridgeway/buyiasleads.git
fi

# Try to push
git push origin main

# If push succeeds
if [ $? -eq 0 ]; then
    echo "✅ Push successful! Website updates live."
    open https://buyiasleads.com
else
    echo "⚠️ Push failed. Check your GitHub credentials."
    # Store credentials for future pushes
    git config --global credential.helper osxkeychain
    git push origin main
fi
