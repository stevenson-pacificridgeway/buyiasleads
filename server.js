const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: ['https://buyiasleads.com', 'https://www.buyiasleads.com'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting - 10 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many payment requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Validate pricing (helper function)
function validatePricing(amount, packageSize) {
  const validPackages = { test: 1, 100: 2000, 200: 3000, 400: 4000 };
  const expectedBase = validPackages[packageSize];
  if (expectedBase === undefined) {
    return { valid: false, error: 'Invalid package size' };
  }

  const isTest = packageSize === 'test';
  const expectedCrmCost = isTest ? 0 : 100;
  const expectedSubtotal = expectedBase + expectedCrmCost;
  const expectedFee = expectedSubtotal * 0.03;
  const expectedTotal = expectedSubtotal + expectedFee;

  // Allow small rounding differences
  if (Math.abs(amount - expectedTotal) > 0.01) {
    return { valid: false, error: 'Invalid amount for selected package' };
  }

  return { valid: true };
}

// Create payment intent
app.post('/create-payment-intent', limiter, async (req, res) => {
  try {
    const { amount, packageSize, customerEmail, customerName } = req.body;

    // Validate required fields
    if (!amount || !packageSize || !customerEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate amount and package
    const pricing = validatePricing(amount, parseInt(packageSize));
    if (!pricing.valid) {
      return res.status(400).json({ error: pricing.error });
    }

    // Validate amount is positive and not too large
    if (amount <= 0 || amount > 10000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    console.log(`Creating payment intent: ${customerEmail} - Package: ${packageSize} - Amount: $${amount}`);

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        packageSize: String(packageSize),
        customerEmail: customerEmail,
        customerName: customerName || 'N/A'
      },
      description: `BuyIASLeads - ${packageSize} leads package + CRM subscription`
    });

    console.log(`Payment intent created: ${paymentIntent.id}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('[ERROR] Creating payment intent:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment intent' });
  }
});

// Confirm payment
app.post('/confirm-payment', limiter, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    console.log(`Confirming payment: ${paymentIntentId}`);

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      console.log(`Payment succeeded: ${paymentIntentId}`);
      res.json({
        success: true,
        message: 'Payment processed successfully',
        paymentIntentId: paymentIntent.id,
        metadata: paymentIntent.metadata
      });
    } else {
      console.log(`Payment status: ${paymentIntent.status} for ${paymentIntentId}`);
      res.status(400).json({
        success: false,
        message: `Payment status: ${paymentIntent.status}`
      });
    }
  } catch (error) {
    console.error('[ERROR] Confirming payment:', error);
    res.status(500).json({ error: error.message || 'Failed to confirm payment' });
  }
});

// Webhook endpoint for Stripe events
app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('[WARNING] Stripe webhook secret not configured');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log(`Webhook event received: ${event.type}`);

    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log(`Payment succeeded: ${paymentIntent.id}`);
        console.log(`Customer email: ${paymentIntent.metadata.customerEmail}`);
        // TODO: Create CRM account, send welcome email, provision leads
        break;

      case 'payment_intent.payment_failed':
        const failedIntent = event.data.object;
        console.log(`Payment failed: ${failedIntent.id}`);
        // TODO: Send failure notification email
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({received: true});
  } catch (error) {
    console.error('[ERROR] Webhook signature verification failed:', error);
    return res.status(400).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[INFO] Server running on port ${PORT}`);
  console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
});
