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
// Parse JSON for every route EXCEPT the Stripe webhook, which needs the raw
// request body intact for signature verification (express.raw runs on that route).
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

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

// Validate pricing (helper function).
// Handles: 'test', '100'/'200'/'400' (new orders, include $100/mo CRM),
// and '100-renewal'/'200-renewal'/'400-renewal' (leads only, no CRM).
function validatePricing(amount, packageSize) {
  const s = String(packageSize);
  const isRenewal = s.endsWith('-renewal');
  const baseKey = isRenewal ? s.slice(0, -('-renewal'.length)) : s;

  const validPackages = { test: 1, crmonly: 0, 100: 2000, 200: 3000, 400: 5000 };
  const expectedBase = validPackages[baseKey];

  if (expectedBase === undefined) {
    return { valid: false, error: `Invalid package size: ${packageSize}` };
  }

  const isTest = baseKey === 'test';
  // Renewals have no CRM seat. Test exercises the subscription flow at $1/mo.
  const expectedCrmCost = isRenewal ? 0 : (isTest ? 1 : 100);
  const expectedSubtotal = expectedBase + expectedCrmCost;
  const expectedFee = expectedSubtotal * 0.03;
  const expectedTotal = expectedSubtotal + expectedFee;

  // Allow small rounding differences (up to 0.05)
  if (Math.abs(amount - expectedTotal) > 0.05) {
    return { valid: false, error: `Invalid amount for package ${packageSize}. Expected $${expectedTotal.toFixed(2)}, got $${amount.toFixed(2)}` };
  }

  return { valid: true, isRenewal };
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

    // Validate amount and package (handles 'test', numeric, and '-renewal' packages)
    const pricing = validatePricing(amount, packageSize);
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
      receipt_email: customerEmail, // Stripe emails the buyer an itemized receipt
      statement_descriptor_suffix: 'BUYIASLEADS', // shows as "HORIZON* BUYIASLEADS" on the buyer's statement
      metadata: {
        packageSize: String(packageSize),
        customerEmail: customerEmail,
        customerName: customerName || 'N/A'
      },
      description: `BuyIASLeads - ${packageSize} leads package${pricing.isRenewal ? ' (renewal, leads only)' : ' + $100/mo CRM seat'}`
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

// The $100/month CRM recurring price. Created once in your Stripe account and
// reused forever via its lookup_key (so no manual dashboard setup is needed).
let crmPriceIdCache = null;
async function getCrmPriceId() {
  if (crmPriceIdCache) return crmPriceIdCache;
  if (process.env.STRIPE_CRM_PRICE_ID) {
    crmPriceIdCache = process.env.STRIPE_CRM_PRICE_ID;
    return crmPriceIdCache;
  }
  const existing = await stripe.prices.list({ lookup_keys: ['buyiasleads_crm_monthly'], limit: 1 });
  if (existing.data.length) {
    crmPriceIdCache = existing.data[0].id;
    return crmPriceIdCache;
  }
  const product = await stripe.products.create({ name: 'BuyIASLeads CRM Seat' });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 10000, // $100.00 / month
    currency: 'usd',
    recurring: { interval: 'month' },
    lookup_key: 'buyiasleads_crm_monthly'
  });
  crmPriceIdCache = price.id;
  console.log(`[BILLING] Created CRM monthly price ${price.id}`);
  return crmPriceIdCache;
}

// A $1/month test price so the FULL subscription flow can be verified for ~$2.
let crmTestPriceIdCache = null;
async function getCrmTestPriceId() {
  if (crmTestPriceIdCache) return crmTestPriceIdCache;
  const existing = await stripe.prices.list({ lookup_keys: ['buyiasleads_crm_test_monthly'], limit: 1 });
  if (existing.data.length) {
    crmTestPriceIdCache = existing.data[0].id;
    return crmTestPriceIdCache;
  }
  const product = await stripe.products.create({ name: 'BuyIASLeads CRM Seat (TEST)' });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 100, // $1.00 / month
    currency: 'usd',
    recurring: { interval: 'month' },
    lookup_key: 'buyiasleads_crm_test_monthly'
  });
  crmTestPriceIdCache = price.id;
  console.log(`[BILLING] Created CRM TEST price ${price.id}`);
  return crmTestPriceIdCache;
}

// Create the order: charges leads + first month CRM + fee TODAY (one payment,
// same total as before) AND sets up the $100/month CRM seat to auto-renew.
app.post('/create-subscription', limiter, async (req, res) => {
  try {
    const { amount, packageSize, customerEmail, customerName } = req.body;

    if (!amount || packageSize === undefined || packageSize === null || !customerEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const isTest = String(packageSize) === 'test';
    const isCrmOnly = String(packageSize) === 'crmonly';
    const leadPrices = { 100: 2000, 200: 3000, 400: 5000 };
    const pkgNum = parseInt(packageSize);
    if (!isTest && !isCrmOnly && !leadPrices[pkgNum]) {
      return res.status(400).json({ error: `Invalid package size: ${packageSize}` });
    }
    const pricing = validatePricing(amount, isTest ? 'test' : (isCrmOnly ? 'crmonly' : pkgNum));
    if (!pricing.valid) return res.status(400).json({ error: pricing.error });
    if (amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Invalid amount' });

    // Recurring CRM line is $100/mo normally, $1/mo for a test order.
    const crmMonthly = isTest ? 1 : 100;
    // First invoice = the recurring CRM line + this one-time amount (leads + fee).
    const oneTimeCents = Math.round((amount - crmMonthly) * 100);

    const customer = await stripe.customers.create({
      email: customerEmail,
      name: customerName || undefined,
      metadata: { packageSize: String(packageSize) }
    });

    const priceId = isTest ? await getCrmTestPriceId() : await getCrmPriceId();

    // One-time leads + processing fee, attached to the first invoice.
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: oneTimeCents,
      currency: 'usd',
      description: isCrmOnly ? 'CRM seat — first-month processing fee' : `${packageSize} indexed annuity leads (one-time) + processing fee`
    });

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { packageSize: String(packageSize), customerEmail, customerName: customerName || 'N/A' }
    });

    const paymentIntent = subscription.latest_invoice.payment_intent;

    // Copy order details onto the PaymentIntent so the existing webhook
    // fulfillment (welcome + owner emails) fires unchanged on the first payment.
    await stripe.paymentIntents.update(paymentIntent.id, {
      statement_descriptor_suffix: 'BUYIASLEADS', // shows as "HORIZON* BUYIASLEADS" on the buyer's statement
      metadata: { packageSize: String(packageSize), customerEmail, customerName: customerName || 'N/A' }
    });

    console.log(`[BILLING] Subscription ${subscription.id} created for ${customerEmail} (${packageSize} leads)`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      subscriptionId: subscription.id
    });
  } catch (error) {
    console.error('[ERROR] Creating subscription:', error.message);
    res.status(500).json({ error: error.message || 'Failed to start checkout' });
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

    // Text the owner too (primary notification channel).
    await sendSms(`New intake form: ${fullName}, ${phone}, ${email}. Order: ${leadOrder ? (leadOrder === 'test' ? 'Test' : leadOrder + ' leads') : 'n/a'}. Best time: ${bestTime || '-'}`);

    // Persist to Follow Up Boss so the lead is never lost to just a text/email (best-effort).
    const _parts = String(fullName).trim().split(/\s+/);
    pushLeadToFUB(
      { firstName: _parts[0] || fullName, lastName: _parts.slice(1).join(' '), email, phone: (toE164US(phone) || phone) },
      {
        tag: 'BuyIASLeads Intake',
        source: 'buyiasleads.com/intake',
        type: 'General Inquiry',
        message: `Post-purchase intake — order: ${leadOrder ? (leadOrder === 'test' ? 'Test' : leadOrder + ' leads') : 'n/a'}; best time: ${bestTime || '-'}; notes: ${notes || '-'}`
      }
    ).catch(() => {});

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

// Twilio SMS notifications to the owner (new orders + intake form submissions).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const OWNER_NOTIFY_PHONE = process.env.OWNER_NOTIFY_PHONE;

async function sendSms(body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !OWNER_NOTIFY_PHONE) {
    console.warn('[SMS] Twilio not fully configured - skipping SMS notification');
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ From: TWILIO_FROM_NUMBER, To: OWNER_NOTIFY_PHONE, Body: body });
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (resp.ok) { console.log('[SMS] Sent notification'); return { sent: true }; }
    const t = await resp.text();
    console.error(`[SMS] Twilio error ${resp.status}: ${t}`);
    return { sent: false, reason: `twilio_${resp.status}` };
  } catch (err) {
    console.error('[SMS] Failed:', err.message);
    return { sent: false, reason: 'exception' };
  }
}

// =====================================================================
// AGENT LEAD CAPTURE  (/agents.html)
// Flow: enter info -> Twilio Verify texts a 6-digit code -> enter code ->
// ONLY on approval do we save + push the lead into Follow Up Boss.
// Every key (Twilio, Follow Up Boss) is read from server-side env ONLY.
// This is a one-way PUSH into Follow Up Boss (no pulling / syncing back).
// =====================================================================
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const FUB_API_KEY = process.env.FUB_API_KEY;
const FUB_SOURCE = process.env.FUB_SOURCE || 'buyiasleads.com/agents';
const FUB_TAG = process.env.FUB_TAG || 'BuyIASLeads Agents';
const AGENT_OFFER_URL = process.env.AGENT_OFFER_URL || 'https://buyiasleads.com/loa-escape-kit.pdf'; // public link to the LOA Escape Kit PDF

// Normalize a US number to E.164 (+1XXXXXXXXXX), or null if it can't be one.
function toE164US(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  return '+1' + d;
}

// Reject obviously fake numbers BEFORE spending a Twilio Verify text on them.
function phoneRejectionReason(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return 'Please enter a 10-digit U.S. mobile number.';
  if (/^(\d)\1{9}$/.test(d)) return 'That number looks invalid.';          // all same digit
  if (d === '1234567890' || d === '0123456789') return 'That number looks invalid.';
  if (d[0] === '0' || d[0] === '1') return 'That area code is not valid.';    // area code 2-9
  if (d[1] === '1' && d[2] === '1') return 'That area code is not valid.';    // N11 (211,311,...)
  if (d[3] === '0' || d[3] === '1') return 'That number looks invalid.';      // exchange 2-9
  return null;
}

function maskPhone(e164) {
  const d = String(e164).replace(/\D/g, '').slice(-10);
  return '(' + d.slice(0, 3) + ') •••-' + d.slice(6);
}

// Tighter limiter for the SMS-sending endpoint (each send costs money / prevents abuse).
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { ok: false, error: 'Too many attempts — please wait a few minutes and try again.' },
  standardHeaders: true, legacyHeaders: false,
});

async function twilioVerifyStart(e164) {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: e164, Channel: 'sms' });
  return fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
}

async function twilioVerifyCheck(e164, code) {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: e164, Code: code });
  const resp = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: data.status };
}

// One-way push of a verified lead into Follow Up Boss via the Events API
// (FUB dedupes, records the source, applies the tag, and can trigger an Action Plan).
// Lead Hub intake (no API key needed). The hub creates/updates the person in Follow Up Boss,
// applies its source tags + the tags we pass, alerts Gregory, and logs the lead. Used whenever
// FUB_API_KEY is not set on this server (it isn't, as of 27 Oct 2026).
const HUB_INTAKE_URL = process.env.HUB_INTAKE_URL || 'https://lead-hub-production-afbe.up.railway.app/intake';
async function pushLeadToHub(l, opts = {}) {
  const body = {
    first_name: l.firstName || '', last_name: l.lastName || '',
    email: l.email || '', phone: l.phone || '',
    source: opts.hubSource || 'buyiasleads',
    site: 'buyiasleads.com',
    page_url: opts.pageUrl || 'https://buyiasleads.com/',
    tags: Array.from(new Set((opts.tags || []).filter(Boolean))),
    message: opts.message || '',
    consent: opts.consent ? 'yes' : undefined,
    consent_source: opts.consent ? (opts.consentSource || 'buyiasleads.com form') : undefined
  };
  try {
    const resp = await fetch(HUB_INTAKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) { console.log('[HUB] lead pushed', data.source || '', data.fub_status || ''); return { ok: true }; }
    console.error(`[HUB] error ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: false, reason: `hub_${resp.status}` };
  } catch (e) {
    console.error('[HUB] push failed:', e.message);
    return { ok: false, reason: 'hub_exception' };
  }
}

async function pushLeadToFUB(l, opts = {}) {
  if (!FUB_API_KEY) {
    const tags = [opts.tag || FUB_TAG].concat(Array.isArray(opts.extraTags) ? opts.extraTags : []);
    return pushLeadToHub(l, { hubSource: opts.hubSource, tags, message: opts.message, consent: opts.consent, pageUrl: opts.pageUrl });
  }
  const creds = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  const tag = opts.tag || FUB_TAG;
  const source = opts.source || FUB_SOURCE;
  const type = opts.type || 'Registration';
  const message = opts.message || ('Lead from ' + source);
  // Base tag + any extra tags (e.g. the licensed/getting-licensed qualifier), de-duped.
  const tags = [tag].concat(Array.isArray(opts.extraTags) ? opts.extraTags : []).filter(Boolean);
  const person = {
    firstName: l.firstName || '',
    emails: l.email ? [{ value: l.email }] : [],
    phones: l.phone ? [{ value: l.phone }] : [],
    tags: Array.from(new Set(tags))
  };
  if (l.lastName) person.lastName = l.lastName;
  const payload = { source, system: 'BuyIASLeads', type, message, person };
  try {
    const resp = await fetch('https://api.followupboss.com/v1/events', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) { console.log('[FUB] lead pushed'); return { ok: true }; }
    const t = await resp.text();
    console.error(`[FUB] error ${resp.status}: ${t}`);
    return { ok: false, reason: `fub_${resp.status}` };
  } catch (e) {
    console.error('[FUB] push failed:', e.message);
    return { ok: false, reason: 'exception' };
  }
}

// Kit (recruiting) leads: route to the LOA recruiting bucket so they get the LOA Escape Kit
// + 10-email recruiting sequence in Follow Up Boss (FUB automations trigger on tag 'LOA Website').
function AGENT_KIT_OPTS(licTag) {
  return { hubSource: 'loastayaway', extraTags: ['LOA Website', 'BuyIASLeads Agents'].concat(licTag ? [licTag] : []),
           message: 'LOA Escape Kit request from buyiasleads.com/agents' + (licTag ? ' (' + licTag + ')' : ''),
           consent: true, pageUrl: 'https://buyiasleads.com/agents.html' };
}

// Lead BUYERS: "Get pricing & sample leads" form on the home page. Goes to the Lead Hub with
// source buyiasleads + tag 'BuyIASLeads' -> starts FUB automation #170 (10 emails / 21 days).
app.post('/buyer-lead', verifyLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website || b._hp) return res.json({ ok: true }); // honeypot
    const firstName = String(b.firstName || '').trim().slice(0, 80);
    const lastName = String(b.lastName || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().slice(0, 200);
    const phone = String(b.phone || '').trim();
    if (!firstName) return res.status(400).json({ ok: false, error: 'First name is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    const reason = phoneRejectionReason(phone);
    if (reason) return res.status(400).json({ ok: false, error: reason });
    const e164 = toE164US(phone);
    const state = String(b.state || '').trim().slice(0, 40);
    const volume = String(b.volume || '').trim().slice(0, 40);
    const consent = b.consent === true || b.consent === 'yes' || b.consent === 'on';
    const msg = ['Website lead-buyer request (buyiasleads.com)', state && ('State(s): ' + state), volume && ('Interested in: ' + volume)].filter(Boolean).join('\n');
    const r = await pushLeadToHub({ firstName, lastName, email, phone: e164 }, {
      hubSource: 'buyiasleads', tags: ['BuyIASLeads', 'BuyIASLeads Website', 'Lead Buyer'],
      message: msg, consent, consentSource: 'buyiasleads.com pricing form', pageUrl: 'https://buyiasleads.com/#get-pricing'
    });
    sendSms(`New lead-buyer (website): ${firstName} ${lastName} (${email}, ${e164}) ${state} ${volume}`).catch(() => {});
    if (!r.ok) return res.status(502).json({ ok: false, error: 'We hit a snag saving your info. Please call 619-374-8100.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[BUYER] exception:', e.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// Step 1: validate the details + fake-number checks, then send the 6-digit code.
app.post('/agents/start-verify', verifyLimiter, async (req, res) => {
  try {
    const { firstName, email, phone } = req.body || {};
    if (!firstName || !String(firstName).trim()) return res.status(400).json({ ok: false, error: 'First name is required.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    const reason = phoneRejectionReason(phone);
    if (reason) return res.status(400).json({ ok: false, error: reason });
    const e164 = toE164US(phone);
    if (!e164) return res.status(400).json({ ok: false, error: 'Please enter a valid U.S. mobile number.' });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
      // No SMS-code service configured: don't block the visitor — save the lead now
      // (the number already passed the fake-number checks above).
      const { licensed } = req.body || {};
      const licTag = licensed === 'Licensed' ? 'Licensed Agent' : licensed === 'Getting licensed' ? 'Getting Licensed' : null;
      const fub = await pushLeadToFUB({ firstName, email, phone: e164 }, AGENT_KIT_OPTS(licTag));
      sendSms(`New agent lead (kit): ${firstName || '—'} (${email}, ${e164}${licTag ? ', ' + licTag : ''}) via buyiasleads.com/agents`).catch(() => {});
      if (!fub.ok) {
        console.error('[AGENTS] save failed (no-verify path):', fub.reason);
        return res.status(502).json({ ok: false, error: 'We hit a snag saving your info. Please book a call or call 619-374-8100.' });
      }
      return res.json({ ok: true, verified: true, offerUrl: AGENT_OFFER_URL || undefined });
    }
    const resp = await twilioVerifyStart(e164);
    if (!resp.ok) {
      const t = await resp.text();
      console.error(`[VERIFY] start error ${resp.status}: ${t}`);
      return res.status(400).json({ ok: false, error: 'We could not text that number. Please check it and try again.' });
    }
    return res.json({ ok: true, masked: maskPhone(e164) });
  } catch (e) {
    console.error('[VERIFY] start exception:', e.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// Step 2: check the code; ONLY on approval do we save + push to Follow Up Boss.
app.post('/agents/check-verify', verifyLimiter, async (req, res) => {
  try {
    const { firstName, email, phone, licensed, code } = req.body || {};
    const e164 = toE164US(phone);
    if (!e164 || !/^\d{6}$/.test(String(code || ''))) return res.status(400).json({ ok: false, error: 'Enter the 6-digit code from the text.' });
    const check = await twilioVerifyCheck(e164, String(code));
    if (!check.ok || check.status !== 'approved') {
      return res.status(400).json({ ok: false, error: 'That code did not match or has expired. Please try again.' });
    }
    // Normalize the qualifier into a FUB tag so licensed, ready-to-buy agents are separable.
    const licTag = licensed === 'Licensed' ? 'Licensed Agent'
                 : licensed === 'Getting licensed' ? 'Getting Licensed'
                 : null;
    // Verified. The push to Follow Up Boss IS the save.
    const fub = await pushLeadToFUB({ firstName, email, phone: e164 }, AGENT_KIT_OPTS(licTag));
    sendSms(`New verified agent lead: ${firstName || '—'} (${email}, ${e164}${licTag ? ', ' + licTag : ''}) via ${FUB_SOURCE}`).catch(() => {});
    if (!fub.ok) {
      // Honest failure: the number verified but the CRM save failed. We already texted the
      // owner above so the lead isn't lost, but we do NOT report a clean success to the page.
      console.error('[AGENTS] FUB push failed after verify:', fub.reason);
      return res.status(502).json({ ok: false, error: 'Your number is verified, but we hit a snag saving you. Please book a call and we will sort it out.' });
    }
    return res.json({ ok: true, offerUrl: AGENT_OFFER_URL || undefined });
  } catch (e) {
    console.error('[AGENTS] check exception:', e.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

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
    sendSms(`New BuyIASLeads order: ${order.packageSize} leads - ${order.name} (${order.email}), $${order.amount.toFixed(2)}`),
    provisionCrmSeat(order)
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[FULFILL] step ${i} failed:`, r.reason);
  });
}

// A payment attempt failed (declined card, etc.). Text the owner so a hot lead
// can be personally recovered. Stripe separately emails the customer a retry link.
async function handleFailedPayment(paymentIntent) {
  const order = orderFromPaymentIntent(paymentIntent);
  const err = paymentIntent.last_payment_error || {};
  const reason = err.decline_code || err.code || err.message || 'unknown';
  const amount = ((paymentIntent.amount || 0) / 100).toFixed(2);
  console.log(`[FAILED] Payment failed for ${order.email} ($${amount}) - ${reason}`);
  try {
    await sendSms(`⚠️ FAILED payment: ${order.name} (${order.email}) — ${order.packageSize} pkg, $${amount}. Reason: ${reason}. Follow up to recover the sale.`);
  } catch (e) {
    console.error('[FAILED] owner SMS error:', e.message);
  }
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

      case 'payment_intent.payment_failed': {
        const failedIntent = event.data.object;
        console.log(`Payment failed: ${failedIntent.id}`);
        handleFailedPayment(failedIntent).catch(err =>
          console.error('[FAILED] Unhandled failure-handler error:', err));
        break;
      }

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
