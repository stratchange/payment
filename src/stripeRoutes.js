const express = require('express');
const bodyParser = require('body-parser');
const { isBillingDbConfigured } = require('./db');
const WebhookEvent = require('./models/WebhookEvent');
const { handleStripeEvent } = require('./bookingService');

const router = express.Router();

function stripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  return require('stripe')(key);
}

router.get('/publishable-config', (_req, res) => {
  const publishableKey = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim() || null;
  res.json({ publishableKey });
});

router.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = stripeClient();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    return res.status(503).send('Billing webhook not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (isBillingDbConfigured()) {
      const existing = await WebhookEvent.findOne({ stripeEventId: event.id }).lean();
      if (existing) return res.json({ received: true, duplicate: true });
    }

    if (
      event.type === 'payment_intent.succeeded'
      || event.type === 'payment_intent.payment_failed'
      || event.type === 'account.updated'
    ) {
      await handleStripeEvent(event);
    }

    if (isBillingDbConfigured()) {
      try {
        await WebhookEvent.create({ stripeEventId: event.id, type: event.type });
      } catch (dupErr) {
        if (!dupErr || dupErr.code !== 11000) throw dupErr;
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Error handling webhook', err);
    return res.status(500).json({ error: 'Webhook handling failed' });
  }
});

module.exports = router;
