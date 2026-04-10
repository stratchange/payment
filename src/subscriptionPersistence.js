const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { isBillingDbConfigured } = require('./db');
const BillingCustomer = require('./models/BillingCustomer');
const BillingSubscription = require('./models/BillingSubscription');

const PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY;
const PRICE_ID_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY;

function mapPlanByPriceId(priceId) {
  if (!priceId) return 'UNKNOWN';
  if (priceId === PRICE_ID_MONTHLY) return 'MONTHLY';
  if (priceId === PRICE_ID_YEARLY) return 'YEARLY';
  return 'UNKNOWN';
}

function resolvePlanFromSubscription(subscription) {
  const items = subscription.items?.data || [];
  const firstItem = items[0];
  const priceId = firstItem?.price?.id || null;
  const interval = firstItem?.price?.recurring?.interval || null;
  if (interval === 'year') return 'YEARLY';
  if (interval === 'month') return 'MONTHLY';
  return mapPlanByPriceId(priceId);
}

function mapStatus(stripeStatus) {
  if (!stripeStatus) return 'UNKNOWN';
  switch (stripeStatus) {
    case 'incomplete':
    case 'incomplete_expired':
      return 'INCOMPLETE';
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'unpaid':
      return 'UNPAID';
    default:
      return 'UNKNOWN';
  }
}

function computeHasProAccess(stripeStatus) {
  return ['active', 'trialing', 'past_due'].includes(stripeStatus);
}

function toDateFromEpochSeconds(epochOrNull) {
  if (epochOrNull == null || epochOrNull === '') return null;
  const n = Number(epochOrNull);
  if (Number.isNaN(n)) return null;
  return new Date(n * 1000);
}

async function resolveUserId(subscription, userIdOverride) {
  let userId = userIdOverride ?? subscription.metadata?.userId;
  if (userId != null && userId !== '') return String(userId).trim() || null;

  const custRef = subscription.customer;
  const custId = typeof custRef === 'string' ? custRef : custRef?.id;
  if (!custId) return null;

  try {
    const customer = await stripe.customers.retrieve(custId);
    if (customer && !customer.deleted && customer.metadata?.userId) {
      return String(customer.metadata.userId).trim() || null;
    }
  } catch (err) {
    console.error('[billing-service] resolveUserId customer retrieve failed:', err?.message || err);
  }
  return null;
}

/**
 * Upsert subscription + customer into the billing MongoDB cluster.
 */
async function persistSubscriptionFromStripe(subscription, userIdOverride) {
  if (!isBillingDbConfigured()) {
    return { skipped: true, reason: 'no_billing_db' };
  }

  const subId = subscription?.id;
  if (!subId) {
    console.warn('[billing-service] persistSubscriptionFromStripe: missing subscription id');
    return { skipped: true, reason: 'no_sub_id' };
  }

  const userId = await resolveUserId(subscription, userIdOverride);
  if (!userId) {
    console.warn('[billing-service] persistSubscriptionFromStripe: no userId (metadata + customer)', {
      subscriptionId: subId,
    });
    return { skipped: true, reason: 'no_user_id' };
  }

  const custRef = subscription.customer;
  const stripeCustomerId =
    typeof custRef === 'string' ? custRef : custRef?.id || null;

  const items = subscription.items?.data || [];
  const stripePriceId = items[0]?.price?.id || null;
  const plan = resolvePlanFromSubscription(subscription);
  const stripeStatus = subscription.status || null;
  const status = mapStatus(stripeStatus);
  const hasProAccess = computeHasProAccess(stripeStatus);
  const currentPeriodEnd = toDateFromEpochSeconds(subscription.current_period_end);
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);

  if (stripeCustomerId) {
    const setCust = { stripeCustomerId };
    if (subscription.customer_email) {
      setCust.email = subscription.customer_email;
    }
    await BillingCustomer.findOneAndUpdate(
      { userId },
      { $set: setCust },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  await BillingSubscription.findOneAndUpdate(
    { stripeSubscriptionId: subId },
    {
      $set: {
        userId,
        stripeCustomerId: stripeCustomerId || undefined,
        stripePriceId,
        plan,
        stripeStatus,
        status,
        hasProAccess,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        lastStripePayloadAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { skipped: false, userId, stripeSubscriptionId: subId };
}

async function getSubscriptionSnapshotForUser(userId) {
  if (!isBillingDbConfigured()) {
    return null;
  }
  const uid = String(userId || '').trim();
  if (!uid) return null;

  const sub = await BillingSubscription.findOne({ userId: uid, hasProAccess: true })
    .sort({ currentPeriodEnd: -1 })
    .lean();

  const customer = await BillingCustomer.findOne({ userId: uid }).lean();

  if (!sub && !customer) return null;

  return {
    customer: customer
      ? {
          userId: customer.userId,
          stripeCustomerId: customer.stripeCustomerId,
          email: customer.email,
        }
      : null,
    subscription: sub
      ? {
          stripeSubscriptionId: sub.stripeSubscriptionId,
          stripeCustomerId: sub.stripeCustomerId,
          stripePriceId: sub.stripePriceId,
          plan: sub.plan,
          stripeStatus: sub.stripeStatus,
          status: sub.status,
          hasProAccess: sub.hasProAccess,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          updatedAt: sub.updatedAt,
        }
      : null,
  };
}

module.exports = {
  persistSubscriptionFromStripe,
  getSubscriptionSnapshotForUser,
  mapStatus,
  resolvePlanFromSubscription,
};
