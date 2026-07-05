const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Debug startup
console.log('[DEBUG] ========== APP STARTING ==========');
console.log('[DEBUG] STRIPE_SECRET_KEY env var exists:', !!process.env.STRIPE_SECRET_KEY);
if (process.env.STRIPE_SECRET_KEY) {
  console.log('[DEBUG] STRIPE_SECRET_KEY length:', process.env.STRIPE_SECRET_KEY.length);
  console.log('[DEBUG] STRIPE_SECRET_KEY starts with:', process.env.STRIPE_SECRET_KEY.substring(0, 8));
}

// Validate Stripe key before initializing
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[CRITICAL ERROR] STRIPE_SECRET_KEY not configured in environment variables');
  process.exit(1);
}

console.log('[DEBUG] Attempting to initialize Stripe...');
const stripeKey = process.env.STRIPE_SECRET_KEY.trim();
const keyPrefix = stripeKey.substring(0, 8);
const keySuffix = stripeKey.substring(stripeKey.length - 4);
console.log(`[INFO] Stripe key loaded: ${keyPrefix}...${keySuffix}`);

let stripe;
try {
  stripe = require('stripe')(stripeKey);
  console.log('[DEBUG] Stripe initialized successfully');
} catch (error) {
  console.error('[CRITICAL ERROR] Failed to initialize Stripe:', error.message);
  process.exit(1);
}

const app = express();
const path = require('path');

// Security middleware
app.use(helmet());
// The website is served from GitHub Pages (buyiasleads.com) while this backend runs on
// Railway, so checkout requests are cross-origin. Allow the site's origins explicitly
// (regardless of NODE_ENV) plus local dev. Anything else is rejected.
const ALLOWED_ORIGINS = [
  'https://buyiasleads.com',
  'https://www.buyiasleads.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
app.use(cors({
  origin: function (origin, callback) {
    // Allow same-origin/non-browser requests (no Origin header) and any allowlisted origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(null, false);
  },
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
  // Ensure packageSize is a valid type (convert if needed)
  let normalizedPackageSize = packageSize;
  if (typeof packageSize === 'number') {
    normalizedPackageSize = packageSize;
  } else if (packageSize === 'test') {
    normalizedPackageSize = 'test';
  } else {
    const numPackage = parseInt(packageSize);
    if (!isNaN(numPackage)) {
      normalizedPackageSize = numPackage;
    }
  }

  const validPackages = { test: 1, 100: 2000, 200: 3000, 400: 4000 };
  const expectedBase = validPackages[normalizedPackageSize];

  if (expectedBase === undefined) {
    return { valid: false, error: `Invalid package size: ${packageSize}` };
  }

  const isTest = normalizedPackageSize === 'test';
  const expectedCrmCost = isTest ? 0 : 100;
  const expectedSubtotal = expectedBase + expectedCrmCost;
  const expectedFee = expectedSubtotal * 0.03;
  const expectedTotal = expectedSubtotal + expectedFee;

  // Allow small rounding differences (up to 0.05)
  if (Math.abs(amount - expectedTotal) > 0.05) {
    return { valid: false, error: `Invalid amount for package ${packageSize}. Expected $${expectedTotal.toFixed(2)}, got $${amount.toFixed(2)}` };
  }

  return { valid: true };
}

// Create payment intent
app.post('/create-payment-intent', limiter, async (req, res) => {
  try {
    const { amount, packageSize, customerEmail, customerName } = req.body;

    // Validate required fields
    if (!amount || packageSize === undefined || packageSize === null || !customerEmail) {
      console.error('[VALIDATION ERROR] Missing fields:', {
        amount: !!amount,
        packageSize: packageSize,
        customerEmail: !!customerEmail,
        received: req.body
      });
      return res.status(400).json({
        error: 'Missing required fields',
        details: { amount: !!amount, packageSize: packageSize, email: !!customerEmail }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate amount and package (handle 'test' string and numeric packages)
    const normalizedPackageSize = packageSize === 'test' ? 'test' : parseInt(packageSize);
    const pricing = validatePricing(amount, normalizedPackageSize);
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
    console.error('[ERROR] Creating payment intent:', {
      message: error.message,
      type: error.type,
      code: error.code,
      raw: error.raw,
      fullError: error
    });
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

// New-customer intake form submission. Emails the details to the owner.
app.post('/intake', limiter, async (req, res) => {
  try {
    const { fullName, email, phone, bestTime, notes, leadOrder } = req.body || {};

    if (!fullName || !email || !phone) {
      return res.status(400).json({ error: 'Please provide your name, email, and phone.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const text =
`New customer intake form submission.

Lead order: ${leadOrder ? (leadOrder === 'test' ? 'Test order' : leadOrder + ' leads') : 'Not specified'}
Name:       ${fullName}
Email:      ${email}
Phone:      ${phone}
Best time:  ${bestTime || '-'}
Notes:      ${notes || '-'}`;

    console.log(`[INTAKE] ${fullName} <${email}> ${phone}`);
    const result = await sendEmail({
      to: OWNER_NOTIFY_EMAIL,
      subject: `New intake form: ${fullName}`,
      text
    });
    // If email isn't configured yet, still succeed for the user but log the full
    // submission so nothing is lost.
    if (!result.sent) {
      console.log('[INTAKE] (email not sent, logged instead) ' + text.replace(/\n/g, ' | '));
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[INTAKE] error:', error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Fulfillment: what happens after a successful payment.
// Sends a welcome email to the customer and an order notification to the owner,
// then hits the CRM-provisioning hook. Uses SendGrid's REST API via native fetch
// (no extra npm dependency). Everything degrades gracefully: if email isn't
// configured, it logs a warning and keeps going instead of throwing.
// ---------------------------------------------------------------------------
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@buyiasleads.com';
const OWNER_NOTIFY_EMAIL = process.env.OWNER_NOTIFY_EMAIL || 'stevenson@pacificridgewayinsurance.com';

async function sendEmail({ to, subject, text }) {
  if (!SENDGRID_API_KEY) {
    console.warn(`[EMAIL] SENDGRID_API_KEY not set - skipping email to ${to} ("${subject}")`);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: SENDGRID_FROM_EMAIL, name: 'BuyIASLeads' },
        subject,
        content: [{ type: 'text/plain', value: text || '' }]
      })
    });
    if (resp.ok) {
      console.log(`[EMAIL] Sent "${subject}" to ${to}`);
      return { sent: true };
    }
    const body = await resp.text();
    console.error(`[EMAIL] SendGrid error ${resp.status} sending to ${to}: ${body}`);
    return { sent: false, reason: `sendgrid_${resp.status}` };
  } catch (err) {
    console.error(`[EMAIL] Failed sending to ${to}:`, err.message);
    return { sent: false, reason: 'exception' };
  }
}

function orderFromPaymentIntent(pi) {
  const m = pi.metadata || {};
  return {
    id: pi.id,
    email: m.customerEmail || '',
    name: m.customerName || 'Customer',
    packageSize: m.packageSize || 'N/A',
    amount: (pi.amount_received || pi.amount || 0) / 100,
    currency: (pi.currency || 'usd').toUpperCase()
  };
}

async function sendWelcomeEmail(order) {
  if (!order.email) return { sent: false, reason: 'no_email' };
  const text =
`Hi ${order.name},

Thanks for your purchase! Here is what happens next:

1. Your CRM login credentials will arrive shortly.
2. Your ${order.packageSize}-lead package is being provisioned.
3. Leads flow into your CRM dashboard in real time as they convert.

Included with your $100/month CRM seat:
- Annuity University (training)
- Oscar Annuity AI (sales support)
- Free indexed-annuity book
- 52-week automated nurture campaign

Questions? Just reply to this email.

- The BuyIASLeads Team`;
  return sendEmail({ to: order.email, subject: 'Welcome to BuyIASLeads - your leads are on the way', text });
}

async function sendOwnerNotification(order) {
  const text =
`New paid order received.

Name:     ${order.name}
Email:    ${order.email}
Package:  ${order.packageSize} leads
Amount:   $${order.amount.toFixed(2)} ${order.currency}
Payment:  ${order.id}

ACTION NEEDED: provision this customer's CRM seat and lead package.`;
  return sendEmail({ to: OWNER_NOTIFY_EMAIL, subject: `New BuyIASLeads order: ${order.packageSize} leads - ${order.name}`, text });
}

// Hook for automated CRM seat creation. Wire this to your CRM's API when ready.
// Until then, the owner notification above prompts manual provisioning.
async function provisionCrmSeat(order) {
  console.log(`[PROVISION] CRM seat pending (manual) for ${order.email} - ${order.packageSize} leads`);
  return { provisioned: false, method: 'manual' };
}

async function handleSuccessfulPayment(paymentIntent) {
  const order = orderFromPaymentIntent(paymentIntent);
  console.log(`[FULFILL] Order ${order.id} for ${order.email} (${order.packageSize} leads, $${order.amount})`);
  const results = await Promise.allSettled([
    sendWelcomeEmail(order),
    sendOwnerNotification(order),
    provisionCrmSeat(order)
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[FULFILL] step ${i} failed:`, r.reason);
  });
}

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
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        console.log(`Payment succeeded: ${paymentIntent.id}`);
        // Acknowledge Stripe right away; run fulfillment (emails + provisioning)
        // asynchronously so a slow email never delays the webhook response.
        handleSuccessfulPayment(paymentIntent).catch(err =>
          console.error('[FULFILL] Unhandled fulfillment error:', err));
        break;
      }

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

// Serve static files (HTML, CSS, JS, images, etc.) - AFTER API routes
app.use(express.static(path.join(__dirname, '.')));

// Fallback: serve index.html for non-API routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[INFO] Server running on port ${PORT}`);
  console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
});
