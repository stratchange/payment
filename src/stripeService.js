const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const SPRING_SYNC_URL = process.env.SPRING_SYNC_URL;
const SPRING_SYNC_API_KEY = process.env.SPRING_SYNC_API_KEY;

// --- helpers ---

function resolvePriceId(plan) {
  const monthly = (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim();
  const yearly = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  if (plan === 'MONTHLY') return monthly;
  if (plan === 'YEARLY') return yearly;
  throw new Error('Invalid plan');
}

function mapPlanByPriceId(priceId) {
  if (!priceId) return 'UNKNOWN';
  const monthly = (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim();
  const yearly = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  if (yearly && priceId === yearly) return 'YEARLY';
  if (monthly && priceId === monthly) return 'MONTHLY';
  return 'UNKNOWN';
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

function toIsoFromEpochSeconds(epochOrNull) {
  if (!epochOrNull && epochOrNull !== 0) return null;
  return new Date(epochOrNull * 1000).toISOString();
}

async function syncSubscriptionToSpring(subscription, userIdOverride) {
  // userId is expected in subscription.metadata.userId,
  // but we also accept a fallback override coming from checkout.session metadata.
  const userIdStr = userIdOverride ?? subscription.metadata?.userId;
  if (!userIdStr) {
    console.warn('No userId found (subscription.metadata.userId missing + no override), skipping sync', {
      subscriptionId: subscription?.id,
    });
    return;
  }
  // userId can be either numeric (legacy) or MongoDB ObjectId (current shippizy-back)
  const userId = String(userIdStr);
  if (!userId || userId === '0') return;

  const items = subscription.items?.data || [];
  const firstItem = items[0];
  const priceRaw = firstItem?.price;
  const priceId =
    typeof priceRaw === 'string'
      ? priceRaw
      : priceRaw && typeof priceRaw === 'object'
        ? priceRaw.id || null
        : null;
  // Prefer interval-based detection (more robust than priceId equality across envs).
  const interval =
    priceRaw && typeof priceRaw === 'object' ? priceRaw.recurring?.interval || null : null; // "month" | "year" | ...
  const fromMeta = subscription.metadata?.billingPeriod;
  const fromPriceId = mapPlanByPriceId(priceId);
  const plan =
    fromMeta === 'YEARLY' || fromMeta === 'MONTHLY'
      ? fromMeta
      : fromPriceId !== 'UNKNOWN'
        ? fromPriceId
        : interval === 'year'
          ? 'YEARLY'
          : interval === 'month'
            ? 'MONTHLY'
            : 'UNKNOWN';
  const status = mapStatus(subscription.status);
  const currentPeriodEndIso = toIsoFromEpochSeconds(subscription.current_period_end);

  const payload = {
    userId,
    plan,
    status,
    currentPeriodEnd: currentPeriodEndIso,
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId
  };

  const headers = {};
  if (SPRING_SYNC_API_KEY) {
    headers['X-Internal-Api-Key'] = SPRING_SYNC_API_KEY;
  }

  try {
    await axios.post(SPRING_SYNC_URL, payload, { headers });
  } catch (err) {
    // Make debugging easier: Spring might return 4xx/5xx with useful details.
    console.error('Spring sync failed', {
      message: err?.message,
      responseStatus: err?.response?.status,
      responseData: err?.response?.data,
      payload,
    });
    throw err;
  }
}


// called by Spring -> Node to get a Checkout URL
async function createCheckoutSession({ userId, email, plan }) {
  const priceId = resolvePriceId(plan);

  // Create a customer per email (or you can search for existing by email)
  const customer = await stripe.customers.create({
    email,
    metadata: { userId: String(userId) }
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customer.id,
    success_url: process.env.STRIPE_SUCCESS_URL,
    cancel_url: process.env.STRIPE_CANCEL_URL,
    client_reference_id: String(userId),
    metadata: {
      userId: String(userId)
    },
    subscription_data: {
      metadata: {
        userId: String(userId)
      }
    },
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ]
  });

  return session.url;
}

// called by Spring -> Node: get an embedded checkout client_secret (no hosted Stripe redirect page)
async function createEmbeddedCheckoutSession({ userId, email, plan }) {
  const priceId = resolvePriceId(plan);

  // Create a customer per email (simplification). Stripe will store subscription state on this customer.
  const customer = await stripe.customers.create({
    email,
    metadata: { userId: String(userId) }
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    ui_mode: "embedded",

    // Embedded checkout uses `return_url` (not success_url/cancel_url).
    // The client will redirect back to our app and we decide success/failed.
    return_url: process.env.STRIPE_RETURN_URL || process.env.STRIPE_SUCCESS_URL,

    client_reference_id: String(userId),
    metadata: {
      userId: String(userId)
    },
    subscription_data: {
      metadata: {
        userId: String(userId)
      }
    },
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ]
  });

  // Embedded checkout sessions return a client_secret used by stripe-js to render the UI.
  return session.client_secret;
}

// called by Spring -> Node to get a billing-portal URL
async function createPortalSession({ customerId }) {
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: process.env.STRIPE_PORTAL_RETURN_URL
  });

  return portalSession.url;
}

// called from webhook handler when we have a Subscription object
async function handleSubscriptionChange(subscription, userIdOverride) {
  const { persistSubscriptionFromStripe } = require('./subscriptionPersistence');
  try {
    await persistSubscriptionFromStripe(subscription, userIdOverride);
  } catch (err) {
    console.error('[billing-service] persistSubscriptionFromStripe failed:', err?.message || err);
  }
  await syncSubscriptionToSpring(subscription, userIdOverride);
}

module.exports = {
  createCheckoutSession,
  createEmbeddedCheckoutSession,
  createPortalSession,
  handleSubscriptionChange,
  syncSubscriptionToSpring,
};