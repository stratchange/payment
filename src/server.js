require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectBillingDb, isBillingDbConfigured } = require('./db');
const billingRoutes = require('./stripeRoutes');

const app = express();
const port = process.env.PORT || 3001;

// Allow browser -> stripe service calls (used by /payment embedded checkout)
app.use(cors());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// All Stripe / billing endpoints under /billing
app.use('/billing', billingRoutes);

(async function start() {
  try {
    await connectBillingDb();
  } catch (err) {
    if (isBillingDbConfigured()) {
      console.error('[billing-service] BILLING_MONGODB_URI is set but connection failed:', err?.message || err);
      process.exit(1);
    }
  }
  app.listen(port, () => {
    console.log(`Billing service listening on port ${port}`);
  });
})();