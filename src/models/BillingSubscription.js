const mongoose = require('mongoose');

const PLAN = Object.freeze(['MONTHLY', 'YEARLY', 'UNKNOWN']);

const billingSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true, trim: true },
    stripeCustomerId: { type: String, trim: true, index: true },
    stripeSubscriptionId: { type: String, required: true, unique: true, trim: true },
    stripePriceId: { type: String, trim: true, default: null },

    plan: { type: String, enum: PLAN, default: 'UNKNOWN' },

    /** Raw Stripe subscription.status */
    stripeStatus: { type: String, trim: true, default: null },

    /** Mapped for downstream sync (ACTIVE, CANCELED, …) — same semantics as stripeService.mapStatus */
    status: { type: String, trim: true, default: 'UNKNOWN' },

    /** Whether the user should have Pro access (active, trialing, past_due). */
    hasProAccess: { type: Boolean, default: false },

    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },

    lastStripePayloadAt: { type: Date, default: null },
  },
  { timestamps: true }
);

billingSubscriptionSchema.index({ userId: 1, hasProAccess: 1 });

module.exports =
  mongoose.models.BillingSubscription || mongoose.model('BillingSubscription', billingSubscriptionSchema);
