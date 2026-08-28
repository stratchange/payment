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
  const priceRaw = firstItem?.price;
  // Stripe may return price as an expanded object or as a bare price id string.
  let priceId =
    typeof priceRaw === 'string'
      ? priceRaw
      : priceRaw && typeof priceRaw === 'object'
        ? priceRaw.id || null
        : null;
  let interval =
    priceRaw && typeof priceRaw === 'object' ? priceRaw.recurring?.interval || null : null;

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
 * Infer paid charge from an expanded Stripe subscription (latest_invoice / PI).
 * Used so subscribe/confirm can unlock Pro without waiting solely on invoice.paid webhook.
 */
function inferPaymentConfirmedFromStripe(subscription) {
  const inv = subscription?.latest_invoice;
  if (!inv || typeof inv !== 'object') return false;
  if (String(inv.status || '') === 'paid') return true;
  const pi = inv.payment_intent;
  if (pi && typeof pi === 'object' && pi.status === 'succeeded') return true;
  return false;
}

/**
 * Pro is granted after paymentConfirmed (invoice.paid webhook or settled PI/invoice on persist).
 * Bare subscription.updated without paid evidence must not unlock access.
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
 * @param {object} subscription Stripe subscription object
 * @param {string} [userIdOverride]
 * @param {{ planOverride?: 'MONTHLY'|'YEARLY' }} [opts]
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
  const priceRaw = items[0]?.price;
  const stripePriceId =
    typeof priceRaw === 'string'
      ? priceRaw
      : priceRaw && typeof priceRaw === 'object'
        ? priceRaw.id || null
        : null;
  let plan = await resolvePlanFromSubscription(subscription);
  const override = extras?.planOverride;
  // transportSubscribe just set this price via getPriceId(period) — use it when Stripe
  // price expand/mapping fails (unexpanded price id → UNKNOWN).
  if (override === 'YEARLY' || override === 'MONTHLY') {
    if (plan === 'UNKNOWN' || !plan) {
      plan = override;
    } else if (plan !== override) {
      console.warn('[billing-service] plan mismatch vs subscribe period', {
        subscriptionId: subId,
        resolved: plan,
        override,
        stripePriceId,
      });
    }
  }

  const mergedExtras = { ...extras };
  if (
    !mergedExtras.paymentFailed &&
    !mergedExtras.paymentConfirmed &&
    inferPaymentConfirmedFromStripe(subscription)
  ) {
    mergedExtras.paymentConfirmed = true;
  }

  const stripeStatus = subscription.status || null;
  const existing = await BillingSubscription.findOne({ stripeSubscriptionId: subId }).lean();
  const { status, hasProAccess } = resolvePersistedAccess({
    stripeStatus,
    existing,
    extras: mergedExtras,
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
    expand: ['data.items.data.price', 'data.latest_invoice.payment_intent'],
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
  const pendingRows = listedRows.filter(
    (row) => !row.hasProAccess && String(row.status || '').toUpperCase() === 'PENDING'
  );
  const staleMs = 5 * 60 * 1000;
  const inconsistentPlan = activeRows.some((row) => {
    if (row.plan === 'MONTHLY' && row.stripePriceId === (process.env.STRIPE_PRICE_ID_YEARLY || '').trim()) return true;
    if (row.plan === 'YEARLY' && row.stripePriceId === (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim()) return true;
    return false;
  });
  const needsReconcile =
    forceReconcile ||
    pendingRows.length > 0 ||
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

async function claimInvoiceEmail(stripeSubscriptionId, invoiceId, kind) {
  if (!isBillingDbConfigured()) return { claimed: true, reason: 'no_billing_db' };
  const subId = String(stripeSubscriptionId || '').trim();
  const invId = String(invoiceId || '').trim();
  if (!subId || !invId) return { claimed: false, reason: 'missing_ids' };

  const field = kind === 'failed' ? 'lastFailedInvoiceId' : 'lastPaidInvoiceId';
  const result = await BillingSubscription.findOneAndUpdate(
    { stripeSubscriptionId: subId, [field]: { $ne: invId } },
    { $set: { [field]: invId } },
    { new: true }
  );
  if (result) return { claimed: true };

  const existing = await BillingSubscription.findOne({ stripeSubscriptionId: subId }).lean();
  if (!existing) return { claimed: true, reason: 'no_subscription_row' };
  if (existing[field] === invId) return { claimed: false, reason: 'already_sent' };
  return { claimed: false, reason: 'claim_conflict' };
}

async function listRenewalReminderCandidates(days) {
  if (!isBillingDbConfigured()) return [];

  const offsetDays = Number.parseInt(String(days ?? '3'), 10);
  if (!Number.isFinite(offsetDays) || offsetDays <= 0) return [];

  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() + offsetDays);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCHours(23, 59, 59, 999);

  const rows = await BillingSubscription.find({
    hasProAccess: true,
    currentPeriodEnd: { $gte: from, $lte: to },
    stripeCustomerId: { $exists: true, $nin: [null, ''] },
  }).lean();

  return rows
    .filter((row) => {
      if (!row.currentPeriodEnd) return false;
      const endMs = new Date(row.currentPeriodEnd).getTime();
      const sentForMs = row.renewalReminderForPeriodEnd
        ? new Date(row.renewalReminderForPeriodEnd).getTime()
        : null;
      return sentForMs !== endMs;
    })
    .map((row) => ({
      userId: row.userId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      stripeCustomerId: row.stripeCustomerId,
      currentPeriodEnd: row.currentPeriodEnd,
      plan: row.plan,
    }));
}

async function markRenewalReminderSent(stripeSubscriptionId, periodEnd) {
  if (!isBillingDbConfigured()) return { ok: false };
  const subId = String(stripeSubscriptionId || '').trim();
  if (!subId || !periodEnd) return { ok: false };

  await BillingSubscription.updateOne(
    { stripeSubscriptionId: subId },
    {
      $set: {
        renewalReminderSentAt: new Date(),
        renewalReminderForPeriodEnd: new Date(periodEnd),
      },
    }
  );
  return { ok: true };
}

module.exports = {
  persistSubscriptionFromStripe,
  getSubscriptionSnapshotForUser,
  reconcileUserSubscriptionsFromStripe,
  mapStatus,
  resolvePlanFromSubscription,
  resolvePersistedAccess,
  inferPaymentConfirmedFromStripe,
  claimInvoiceEmail,
  listRenewalReminderCandidates,
  markRenewalReminderSent,
};
