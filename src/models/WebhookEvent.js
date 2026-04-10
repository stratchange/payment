const mongoose = require('mongoose');

/** Idempotent webhook processing by Stripe event id. */
const webhookEventSchema = new mongoose.Schema(
  {
    stripeEventId: { type: String, required: true, unique: true, trim: true },
    type: { type: String, trim: true, default: null },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

module.exports = mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', webhookEventSchema);
