require('dotenv').config();
const express = require('express');
const billingRoutes = require('./stripeRoutes');

const app = express();
const port = process.env.PORT || 3001;

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// All Stripe / billing endpoints under /billing
app.use('/billing', billingRoutes);

app.listen(port, () => {
  console.log(`Billing service listening on port ${port}`);
});