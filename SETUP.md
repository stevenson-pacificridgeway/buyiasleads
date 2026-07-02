# BuyIASLeads - Quick Setup

## Your Stripe Keys

**Publishable Key (use in frontend):**
```
pk_live_51TS1hU3FlweH7tQS0IxH6auf9vXsDcIDRKR23boBkllJgEVrXn4HGMKLMCTsRZIF4EEFhKhjJrRMr6Vh1IHd82jz00uzspwAiE
```

**Secret Key (keep private - use in backend only):**
- Go to: https://dashboard.stripe.com/apikeys
- Click "Reveal live key"
- Copy the full key starting with `sk_live_`
- Add to Railway environment variables

## Deploy Backend to Railway

1. Go to https://railway.app
2. Sign in with GitHub
3. New Project → Deploy from GitHub
4. Select `buyiasleads` repo
5. Add Environment Variables:
   - `STRIPE_SECRET_KEY`: Your sk_live_ key
   - `STRIPE_PUBLISHABLE_KEY`: pk_live_51TS1hU3FlweH7tQS0IxH6auf9vXsDcIDRKR23boBkllJgEVrXn4HGMKLMCTsRZIF4EEFhKhjJrRMr6Vh1IHd82jz00uzspwAiE
   - `PORT`: 3000

6. Get your Railway URL (e.g., `https://buyiasleads-prod.up.railway.app`)

7. Update checkout.html line 417:
   ```javascript
   const BACKEND_URL = 'https://your-railway-url.up.railway.app';
   ```

8. Commit and push to GitHub to trigger redeploy

## Files Modified

- ✅ `checkout.html` - Added Stripe payment form
- ✅ `server.js` - Backend Stripe integration
- ✅ `package.json` - Node dependencies
- ✅ `.env.example` - Environment variables template
- ✅ `DEPLOYMENT.md` - Full deployment guide

## Next Steps

1. Get your Stripe secret key from dashboard
2. Deploy backend to Railway
3. Update checkout.html with your Railway URL
4. Test payment flow
5. Go live!
