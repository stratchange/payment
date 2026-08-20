const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { isBillingDbConfigured } = require('./db');
const BillingCustomer = require('./models/BillingCustomer');
const BillingSubscription = require('./models/BillingSubscription');

function mapPlanByPriceId(priceId) {
  if (!priceId) return 'UNKNOWN';
  const monthly = (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim();
  const yearly = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  if (yearly && priceId === yearly) return 'YEARLY';
  if (monthly && priceId === monthly) return 'MONTHLY';
  return 'UNKNOWN';
}

async function resolvePlanFromSubscription(subscription) {
  const items = subscription.items?.data || [];
  const firstItem = items[0];
  let price = firstItem?.price;
  let priceId = typeof price === 'string' ? price : price?.id || null;
  let interval = typeof price === 'object' && price?.recurring?.interval ? price.recurring.interval : null;

  if (!interval && priceId) {
    try {
      const fetched = await stripe.prices.retrieve(priceId);
      interval = fetched?.recurring?.interval || null;
      priceId = fetched?.id || priceId;
    } catch (err) {
      console.warn('[billing-service] resolvePlanFromSubscription price retrieve failed:', err?.message || err);
    }
  }

  const fromMeta = subscription.metadata?.billingPeriod;
  if (fromMeta === 'YEARLY' || fromMeta === 'MONTHLY') return fromMeta;

  const fromPriceId = mapPlanByPriceId(priceId);
  if (fromPriceId !== 'UNKNOWN') return fromPriceId;

  if (interval === 'year') return 'YEARLY';
  if (interval === 'month') return 'MONTHLY';
  return 'UNKNOWN';
}

function subscriptionPeriodEnd(subscription) {
  return (
    toDateFromEpochSeconds(subscription.current_period_end) ||
    toDateFromEpochSeconds(subscription.items?.data?.[0]?.current_period_end)
  );
}

function pickBestSubscriptionRow(rows) {
  if (!rows?.length) return null;
  return [...rows].sort((a, b) => {
    if (a.plan === 'YEARLY' && b.plan !== 'YEARLY') return -1;
    if (b.plan === 'YEARLY' && a.plan !== 'YEARLY') return 1;
    const aEnd = a.currentPeriodEnd ? new Date(a.currentPeriodEnd).getTime() : 0;
    const bEnd = b.currentPeriodEnd ? new Date(b.currentPeriodEnd).getTime() : 0;
    return bEnd - aEnd;
  })[0];
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

function isTerminalStripeStatus(stripeStatus) {
  return ['canceled', 'unpaid', 'incomplete_expired'].includes(String(stripeStatus || ''));
}

/**
 * Pro is granted only after invoice.paid (paymentConfirmed).
 * Client subscribe / subscription.updated must not unlock access (card OK ≠ funds captured).
 */
function resolvePersistedAccess({ stripeStatus, existing, extras = {} }) {
  if (isTerminalStripeStatus(stripeStatus)) {
    return { hasProAccess: false, status: mapStatus(stripeStatus) };
  }
  if (extras.paymentFailed) {
    return { hasProAccess: false, status: 'UNPAID' };
  }
  if (extras.paymentConfirmed) {
    return {
      hasProAccess: computeHasProAccess(stripeStatus),
      status: mapStatus(stripeStatus),
    };
  }
  if (existing?.hasProAccess && computeHasProAccess(stripeStatus)) {
    return { hasProAccess: true, status: mapStatus(stripeStatus) };
  }
  return { hasProAccess: false, status: 'PENDING' };
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
async function persistSubscriptionFromStripe(subscription, userIdOverride, extras = {}) {
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
  const firstPrice = items[0]?.price;
  const stripePriceId = typeof firstPrice === 'string' ? firstPrice : firstPrice?.id || null;
  const plan =
    extras.planOverride === 'YEARLY' || extras.planOverride === 'MONTHLY'
      ? extras.planOverride
      : await resolvePlanFromSubscription(subscription);
  const stripeStatus = subscription.status || null;
  const existing = await BillingSubscription.findOne({ stripeSubscriptionId: subId }).lean();
  const { status, hasProAccess } = resolvePersistedAccess({
    stripeStatus,
    existing,
    extras,
  });
  const currentPeriodEnd = subscriptionPeriodEnd(subscription);
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

async function reconcileUserSubscriptionsFromStripe(userId) {
  if (!isBillingDbConfigured()) return { skipped: true, reason: 'no_billing_db' };
  const uid = String(userId || '').trim();
  if (!uid) return { skipped: true, reason: 'no_user_id' };

  const customer = await BillingCustomer.findOne({ userId: uid }).lean();
  if (!customer?.stripeCustomerId) return { skipped: true, reason: 'no_customer' };

  const listed = await stripe.subscriptions.list({
    customer: customer.stripeCustomerId,
    status: 'all',
    limit: 20,
    expand: ['data.items.data.price'],
  });

  for (const sub of listed.data || []) {
    await persistSubscriptionFromStripe(sub, uid);
  }

  return { skipped: false, count: (listed.data || []).length };
}

async function getSubscriptionSnapshotForUser(userId, { forceReconcile = false } = {}) {
  if (!isBillingDbConfigured()) {
    return null;
  }
  const uid = String(userId || '').trim();
  if (!uid) return null;

  const listedRows = await BillingSubscription.find({ userId: uid }).lean();
  const activeRows = listedRows.filter((row) => row.hasProAccess);
  const staleMs = 5 * 60 * 1000;
  const inconsistentPlan = activeRows.some((row) => {
    if (row.plan === 'MONTHLY' && row.stripePriceId === (process.env.STRIPE_PRICE_ID_YEARLY || '').trim()) return true;
    if (row.plan === 'YEARLY' && row.stripePriceId === (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim()) return true;
    return false;
  });
  const needsReconcile =
    forceReconcile ||
    activeRows.length > 1 ||
    inconsistentPlan ||
    activeRows.some((row) => {
      if (!row.lastStripePayloadAt) return true;
      return Date.now() - new Date(row.lastStripePayloadAt).getTime() > staleMs;
    });

  if (needsReconcile) {
    try {
      await reconcileUserSubscriptionsFromStripe(uid);
    } catch (err) {
      console.warn('[billing-service] reconcileUserSubscriptionsFromStripe failed:', err?.message || err);
    }
  }

  const freshRows = await BillingSubscription.find({ userId: uid }).lean();
  const sub =
    pickBestSubscriptionRow(freshRows.filter((row) => row.hasProAccess)) ||
    pickBestSubscriptionRow(freshRows.filter((row) => String(row.status) === 'PENDING')) ||
    pickBestSubscriptionRow(freshRows);

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
  reconcileUserSubscriptionsFromStripe,
  mapStatus,
  resolvePlanFromSubscription,
  resolvePersistedAccess,
};
