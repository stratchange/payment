const mongoose = require('mongoose');

/**
 * Separate MongoDB cluster for billing-only data (not Shippizy main DB).
 * Set BILLING_MONGODB_URI in .env (e.g. second Atlas cluster).
 */
async function connectBillingDb() {
  const uri = (process.env.BILLING_MONGODB_URI || '').trim();
  if (!uri) {
    console.warn('[billing-service] BILLING_MONGODB_URI not set; booking persistence is disabled.');
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
  const WebhookEvent = require('./models/WebhookEvent');
  const bookingModels = require('./models/booking');

  await WebhookEvent.syncIndexes();
  await Promise.all(Object.values(bookingModels).map((Model) => Model.syncIndexes()));
  console.log('[billing-service] Billing database schema ready (collections / indexes).');
}

function isBillingDbConfigured() {
  return Boolean((process.env.BILLING_MONGODB_URI || '').trim());
}

module.exports = { connectBillingDb, isBillingDbConfigured };
