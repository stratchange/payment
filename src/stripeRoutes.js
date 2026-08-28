const express = require('express');
const bodyParser = require('body-parser');
const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);

const {
  createCheckoutSession,
  createEmbeddedCheckoutSession,
  createPortalSession,
  handleSubscriptionChange,
  syncSubscriptionToSpring,
} = require('./stripeService');
const { isBillingDbConfigured } = require('./db');
const WebhookEvent = require('./models/WebhookEvent');
const { persistSubscriptionFromStripe, getSubscriptionSnapshotForUser, claimInvoiceEmail, listRenewalReminderCandidates, markRenewalReminderSent } = require('./subscriptionPersistence');
const transportRoutes = require('./transportRoutes');

const router = express.Router();

router.use(transportRoutes);

function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  const direct = invoice.subscription;
  if (direct) return String(typeof direct === 'string' ? direct : direct.id);
  const nested = invoice.parent?.subscription_details?.subscription;
  if (nested) return String(typeof nested === 'string' ? nested : nested.id);
  return null;
}

async function persistInvoiceOutcome(invoice, extras) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;
  const subscription = await stripeLib.subscriptions.retrieve(subId, {
    expand: ['items.data.price'],
  });
  const userId = invoice.metadata?.userId || subscription.metadata?.userId;
  await persistSubscriptionFromStripe(subscription, userId, extras);
  await syncSubscriptionToSpring(subscription, userId);

  const invoiceId = invoice?.id ? String(invoice.id) : null;
  if (invoiceId) {
    const { notifyMainApiSubscriptionInvoice } = require('./subscriptionInvoiceNotify');
    if (extras.paymentConfirmed) {
      await notifyMainApiSubscriptionInvoice({ invoiceId, outcome: 'paid' });
    } else if (extras.paymentFailed) {
      await notifyMainApiSubscriptionInvoice({ invoiceId, outcome: 'failed' });
    }
  }
}

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
      if (isBillingDbConfigured()) {
        const existing = await WebhookEvent.findOne({ stripeEventId: event.id }).lean();
        if (existing) {
          return res.json({ received: true, duplicate: true });
        }
      }

      console.log('Received webhook event:', event.type);

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.subscription) {
            const subscription = await stripeLib.subscriptions.retrieve(session.subscription, {
              expand: ['items.data.price', 'latest_invoice.payment_intent'],
            });
            const userIdFromCheckout = session.metadata?.userId;
            const paid =
              session.payment_status === 'paid' ||
              (session.payment_status === 'no_payment_required' && session.status === 'complete');
            await persistSubscriptionFromStripe(subscription, userIdFromCheckout, {
              paymentConfirmed: Boolean(paid),
            });
            await syncSubscriptionToSpring(subscription, userIdFromCheckout);
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const raw = event.data.object;
          let subscription = raw;
          try {
            subscription = await stripeLib.subscriptions.retrieve(raw.id, {
              expand: ['items.data.price', 'latest_invoice.payment_intent'],
            });
          } catch (err) {
            console.warn('[billing-service] webhook subscription retrieve failed, using event payload:', err?.message || err);
          }
          await handleSubscriptionChange(subscription, subscription.metadata?.userId || raw.metadata?.userId);
          break;
        }

        case 'invoice.paid':
        case 'invoice_payment.paid': {
          const obj = event.data.object;
          const invoice =
            event.type === 'invoice_payment.paid' && obj?.invoice
              ? await stripeLib.invoices.retrieve(String(obj.invoice))
              : obj;
          await persistInvoiceOutcome(invoice, { paymentConfirmed: true });
          break;
        }

        case 'invoice.payment_failed': {
          await persistInvoiceOutcome(event.data.object, { paymentFailed: true });
          break;
        }

        default:
        // ignore other events
      }

      if (isBillingDbConfigured()) {
        try {
          await WebhookEvent.create({ stripeEventId: event.id, type: event.type });
        } catch (dupErr) {
          if (!dupErr || dupErr.code !== 11000) {
            throw dupErr;
          }
        }
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

// Internal: read subscription snapshot from billing MongoDB (separate cluster)
router.get('/internal/subscription', async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!isBillingDbConfigured()) {
      return res.status(503).json({ error: 'Billing database not configured' });
    }
    const userId = req.query.userId;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const snapshot = await getSubscriptionSnapshotForUser(userId);
    if (!snapshot) {
      return res.status(404).json({ error: 'No billing record for user' });
    }

    return res.json(snapshot);
  } catch (err) {
    console.error('Error reading internal subscription', err);
    res.status(500).json({ error: 'Failed to read subscription' });
  }
});

router.post('/internal/invoice-outcome', bodyParser.json(), async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const subscriptionId = String(req.body?.subscriptionId || '').trim();
    const outcome = String(req.body?.outcome || '').trim().toLowerCase();
    if (!subscriptionId) {
      return res.status(400).json({ error: 'subscriptionId is required' });
    }
    if (outcome !== 'paid' && outcome !== 'failed') {
      return res.status(400).json({ error: 'outcome must be paid or failed' });
    }
    const subscription = await stripeLib.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    const extras = outcome === 'paid' ? { paymentConfirmed: true } : { paymentFailed: true };
    await persistSubscriptionFromStripe(subscription, subscription.metadata?.userId, extras);
    await syncSubscriptionToSpring(subscription, subscription.metadata?.userId);
    return res.json({ ok: true, hasProAccess: extras.paymentConfirmed === true });
  } catch (err) {
    console.error('Error applying invoice outcome', err);
    res.status(500).json({ error: 'Failed to apply invoice outcome' });
  }
});

router.post('/internal/claim-invoice-email', bodyParser.json(), async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const subscriptionId = String(req.body?.subscriptionId || '').trim();
    const invoiceId = String(req.body?.invoiceId || '').trim();
    const kind = String(req.body?.kind || 'paid').trim().toLowerCase();
    if (!subscriptionId || !invoiceId) {
      return res.status(400).json({ error: 'subscriptionId and invoiceId are required' });
    }
    if (kind !== 'paid' && kind !== 'failed') {
      return res.status(400).json({ error: 'kind must be paid or failed' });
    }
    const result = await claimInvoiceEmail(subscriptionId, invoiceId, kind);
    return res.json(result);
  } catch (err) {
    console.error('Error claiming invoice email', err);
    res.status(500).json({ error: 'Failed to claim invoice email' });
  }
});

router.get('/internal/renewal-reminder-candidates', async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!isBillingDbConfigured()) {
      return res.status(503).json({ error: 'Billing database not configured' });
    }
    const days = req.query.days;
    const candidates = await listRenewalReminderCandidates(days);
    return res.json({ candidates });
  } catch (err) {
    console.error('Error listing renewal reminder candidates', err);
    res.status(500).json({ error: 'Failed to list renewal reminder candidates' });
  }
});

router.post('/internal/mark-renewal-reminder', bodyParser.json(), async (req, res) => {
  try {
    if (!requireInternalKey(req, res)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const subscriptionId = String(req.body?.subscriptionId || '').trim();
    const periodEnd = req.body?.periodEnd;
    if (!subscriptionId || !periodEnd) {
      return res.status(400).json({ error: 'subscriptionId and periodEnd are required' });
    }
    const result = await markRenewalReminderSent(subscriptionId, periodEnd);
    return res.json(result);
  } catch (err) {
    console.error('Error marking renewal reminder', err);
    res.status(500).json({ error: 'Failed to mark renewal reminder' });
  }
});

module.exports = router;