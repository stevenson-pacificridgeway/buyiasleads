#!/bin/bash
cd ~/Desktop/BuyIASLeads
git push https://stevenson-pacificridgeway:ghp_lTvg5kljUxyjwbqZ8bl0DpoAkhYAkD44JleG@github.com/stevenson-pacificridgeway/buyiasleads.git main
if [ $? -eq 0 ]; then
    echo "✅ Push successful! Website is now live."
    sleep 2
    open https://buyiasleads.com
else
    echo "❌ Push failed"
fi
