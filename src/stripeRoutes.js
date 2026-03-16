const express = require('express');
const bodyParser = require('body-parser');
const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);

const {
  createCheckoutSession,
  createPortalSession,
  handleSubscriptionChange
} = require('./stripeService');

const router = express.Router();

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
            await handleSubscriptionChange(subscription);
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          await handleSubscriptionChange(subscription);
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

module.exports = router;