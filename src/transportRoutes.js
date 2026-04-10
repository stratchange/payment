const express = require('express');
const bodyParser = require('body-parser');
const ts = require('./transportSubscriptionService');
const HttpError = ts.HttpError;

const router = express.Router();

function requireInternalKey(req, res) {
  const expected = process.env.SPRING_SYNC_API_KEY;
  if (!expected) return true;
  const got = req.headers['x-internal-api-key'];
  return got === expected;
}

function handle(fn) {
  return async (req, res) => {
    try {
      if (!requireInternalKey(req, res)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const data = await fn(req);
      res.json(data);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[transport]', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  };
}

/** Public: publishable key for Payment Element (same Stripe account as secret key). */
router.get('/publishable-config', (req, res) => {
  const publishableKey = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim() || null;
  res.json({ publishableKey });
});

router.post('/transport/setup-intent', bodyParser.json(), handle((req) => ts.transportSetupIntent(req.body || {})));

router.get('/transport/default-card', handle((req) => ts.transportGetDefaultCard({ userId: req.query.userId })));

router.post(
  '/transport/default-payment-method',
  bodyParser.json(),
  handle((req) => ts.transportSetDefaultPaymentMethod(req.body || {}))
);

router.post('/transport/subscribe', bodyParser.json(), handle((req) => ts.transportSubscribe(req.body || {})));

router.post(
  '/transport/confirm-payment',
  bodyParser.json(),
  handle((req) => ts.transportConfirmPayment(req.body || {}))
);

router.post('/transport/portal', bodyParser.json(), handle((req) => ts.transportPortal(req.body || {})));

router.post('/transport/cancel', bodyParser.json(), handle((req) => ts.transportCancel(req.body || {})));

router.post(
  '/transport/subscription-checkout-session',
  bodyParser.json(),
  handle((req) => ts.transportSubscriptionCheckoutSession(req.body || {}))
);

router.post(
  '/transport/confirm-checkout-session',
  bodyParser.json(),
  handle((req) => ts.transportConfirmCheckoutSession(req.body || {}))
);

module.exports = router;
