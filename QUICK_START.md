# 🚀 Get Stripe Live in 5 Minutes

## Step 1: Push to GitHub (Do this NOW)
```bash
cd ~/Desktop/BuyIASLeads
git add -A
git commit -m "Add Stripe"
git push
```

## Step 2: Deploy Backend (Railway - 3 clicks)
1. Go to **https://railway.app**
2. Click **New Project** → **Deploy from GitHub** → select `buyiasleads` → **Deploy Now**
3. Wait 2 minutes for it to deploy
4. When done, Railway shows you a URL like: `https://buyiasleads-prod.up.railway.app`
5. Copy that URL

## Step 3: Set Stripe Keys in Railway
While deployment runs, go to **https://dashboard.stripe.com/apikeys**
- Click **Reveal live key** next to Secret key
- Copy the `sk_live_...` key

Back in Railway dashboard:
1. Click **Variables**
2. Add these 2 variables:
   - `STRIPE_SECRET_KEY` = `sk_live_...` (paste what you copied)
   - `PORT` = `3000`

## Step 4: Tell Me Your Railway URL
Once Railway is done deploying, DM me:
"My Railway URL is: https://buyiasleads-prod.up.railway.app"

I'll update your checkout page and push it live. Done.

---

**That's it.** Your site will accept real Stripe payments immediately after.
