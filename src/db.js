const mongoose = require('mongoose');

/**
 * Separate MongoDB cluster for billing-only data (not Shippizy main DB).
 * Set BILLING_MONGODB_URI in .env (e.g. second Atlas cluster).
 */
async function connectBillingDb() {
  const uri = (process.env.BILLING_MONGODB_URI || '').trim();
  if (!uri) {
    console.warn('[billing-service] BILLING_MONGODB_URI not set; local subscription DB persistence is disabled.');
    return false;
  }
  if (mongoose.connection.readyState === 1) {
    return true;
  }
  await mongoose.connect(uri);
  console.log('[billing-service] Connected to billing MongoDB cluster.');

  // Create collections + indexes on first run (Mongo creates the DB name from the URI on first use).
  await ensureBillingCollections();
  return true;
}

/**
 * Ensures billing collections exist and indexes match Mongoose schemas.
 */
async function ensureBillingCollections() {
  const BillingCustomer = require('./models/BillingCustomer');
  const BillingSubscription = require('./models/BillingSubscription');
  const WebhookEvent = require('./models/WebhookEvent');

  await BillingCustomer.syncIndexes();
  await BillingSubscription.syncIndexes();
  await WebhookEvent.syncIndexes();
  console.log('[billing-service] Billing database schema ready (collections / indexes).');
}

function isBillingDbConfigured() {
  return Boolean((process.env.BILLING_MONGODB_URI || '').trim());
}

module.exports = { connectBillingDb, isBillingDbConfigured };
