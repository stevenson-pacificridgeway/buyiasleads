# BuyIASLeads Deployment Guide

## Frontend (GitHub Pages)
Your website is already deployed to GitHub Pages at https://buyiasleads.com

## Backend (Stripe Payment Processing)

### Option 1: Deploy to Railway (Recommended)

1. **Go to Railway.app**
   - Visit https://railway.app
   - Sign in with GitHub

2. **Create New Project**
   - Click "New Project" → "Deploy from GitHub"
   - Select your `stevenson-pacificridgeway/buyiasleads` repository
   - Click "Deploy Now"

3. **Set Environment Variables**
   - Go to your Railway project
   - Click "Variables"
   - Add the following:
     - `STRIPE_SECRET_KEY`: Your Stripe secret key (sk_live_...)
     - `STRIPE_PUBLISHABLE_KEY`: pk_live_51TS1hU3FlweH7tQS0IxH6auf9vXsDcIDRKR23boBkllJgEVrXn4HGMKLMCTsRZIF4EEFhKhjJrRMr6Vh1IHd82jz00uzspwAiE
     - `PORT`: 3000
     - `FRONTEND_URL`: https://buyiasleads.com

4. **Get Your Backend URL**
   - After deployment, Railway will give you a domain like: `https://your-app.up.railway.app`
   - Copy this URL

5. **Update checkout.html**
   - Open `/Desktop/BuyIASLeads/checkout.html`
   - Find line with `const BACKEND_URL = 'https://your-railway-backend.up.railway.app'`
   - Replace with your actual Railway URL
   - Save and commit to GitHub
   - Push to trigger redeploy

### Getting Your Stripe Secret Key

Your **Publishable Key** is:
```
pk_live_51TS1hU3FlweH7tQS0IxH6auf9vXsDcIDRKR23boBkllJgEVrXn4HGMKLMCTsRZIF4EEFhKhjJrRMr6Vh1IHd82jz00uzspwAiE
```

For your **Secret Key** (sk_live_...):
1. Go to https://dashboard.stripe.com/apikeys
2. Click "Reveal live key" next to the Secret key
3. Copy the full key (starts with `sk_live_`)
4. Add it to Railway environment variables

## What Happens During Checkout

1. User fills out form and enters card details
2. Frontend creates a Stripe payment intent via backend
3. Stripe securely processes the payment
4. Backend confirms payment succeeded
5. User sees success message and receives confirmation

## Testing

To test locally before deploying:
1. Install dependencies: `npm install`
2. Create `.env` file with your Stripe keys
3. Run: `npm start`
4. Frontend will call `http://localhost:3000`

## Security Notes

- ✅ Secret keys are ONLY in backend environment variables
- ✅ Frontend uses only the Publishable key
- ✅ Card data never touches your servers
- ✅ All payments processed through Stripe
