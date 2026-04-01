const express = require('express');
const bodyParser = require('body-parser');
const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);

const {
  createCheckoutSession,
  createEmbeddedCheckoutSession,
  createPortalSession,
  handleSubscriptionChange
} = require('./stripeService');

const router = express.Router();

function requireInternalKey(req, res) {
  const expected = process.env.SPRING_SYNC_API_KEY;
  if (!expected) return true;
  const got = req.headers['x-internal-api-key'];
  return got === expected;
}

// 1) Spring -> Node: create checkout session
// Body expected from Spring:
// { "userId": 123, "email": "t@x.com", "plan": "MONTHLY" | "YEARLY" }
router.post('/checkout-session', bodyParser.json(), async (req, res) => {
  try {
    const { userId, email, plan } = req.body;
    if (!userId || !email || !plan) {
      return res.status(400).json({ error: 'userId, email and plan are required' });
    }

    const url = await createCheckoutSession({ userId, email, plan });
    res.json({ url });
  } catch (err) {
    console.error('Error creating checkout session', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// 1.5) Spring -> Node: create embedded checkout client_secret (no hosted Stripe redirect page)
// Body expected from Spring:
// { "userId": 123, "email": "t@x.com", "plan": "MONTHLY" | "YEARLY" }
router.post('/embedded-checkout-session', bodyParser.json(), async (req, res) => {
  try {
    const { userId, email, plan } = req.body;
    if (!userId || !email || !plan) {
      return res.status(400).json({ error: 'userId, email and plan are required' });
    }

    const clientSecret = await createEmbeddedCheckoutSession({ userId, email, plan });
    res.json({ clientSecret });
  } catch (err) {
    console.error('Error creating embedded checkout session', err);
    res.status(500).json({ error: 'Failed to create embedded checkout session' });
  }
});

// 2) Spring -> Node: create billing portal session
// Body expected from Spring:
// { "customerId": "cus_..." }
router.post('/portal', bodyParser.json(), async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    const url = await createPortalSession({ customerId });
    res.json({ url });
  } catch (err) {
    console.error('Error creating portal session', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// 3) Stripe -> Node: webhook
// IMPORTANT: raw body for signature verification
router.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      // req.body is a Buffer here
      event = stripeLib.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      console.log('Received webhook event:', event.type);

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.subscription) {
            const subscription = await stripeLib.subscriptions.retrieve(
              session.subscription
            );
            const userIdFromCheckout = session.metadata?.userId;
            await handleSubscriptionChange(subscription, userIdFromCheckout);
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          await handleSubscriptionChange(subscription, subscription.metadata?.userId);
          break;
        }

        default:
        // ignore other events
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Error handling webhook', err);
      res.status(500).json({ error: 'Webhook handling failed' });
    }
  }
);

// Stripe -> Node: frontend can ask if the embedded checkout session succeeded.
// Query expected: ?session_id=cs_test_...
router.get('/embedded-checkout-session-status', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const session = await stripeLib.checkout.sessions.retrieve(sessionId);

    // For subscription checkout, "complete" corresponds to success.
    const status = session.status;
    const paymentStatus = session.payment_status || null;

    res.json({
      status,
      paymentStatus,
      customerId: session.customer || null,
      subscriptionId: session.subscription || null,
    });
  } catch (err) {
    console.error('Error retrieving embedded checkout session status', err);
    res.status(500).json({ error: 'Failed to retrieve session status' });
  }
});

// Internal: backend fetches invoices for a Stripe customer
router.get('/invoices', async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const customerId = req.query.customerId;
    if (!customerId || typeof customerId !== 'string') {
      return res.status(400).json({ error: 'customerId is required' });
    }

    const invoices = await stripeLib.invoices.list({
      customer: customerId,
      limit: 20,
    });

    res.json({
      invoices: (invoices.data || []).map((inv) => ({
        id: inv.id,
        status: inv.status,
        amountPaid: inv.amount_paid,
        amountDue: inv.amount_due,
        currency: inv.currency,
        created: inv.created,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        number: inv.number,
        periodStart: inv.period_start,
        periodEnd: inv.period_end,
      })),
    });
  } catch (err) {
    console.error('Error listing invoices', err);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

module.exports = router;