const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY;
const PRICE_ID_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY;

const SPRING_SYNC_URL = process.env.SPRING_SYNC_URL;
const SPRING_SYNC_API_KEY = process.env.SPRING_SYNC_API_KEY;

// --- helpers ---

function resolvePriceId(plan) {
  if (plan === 'MONTHLY') return PRICE_ID_MONTHLY;
  if (plan === 'YEARLY') return PRICE_ID_YEARLY;
  throw new Error('Invalid plan');
}

function mapPlanByPriceId(priceId) {
  if (priceId === PRICE_ID_MONTHLY) return 'MONTHLY';
  if (priceId === PRICE_ID_YEARLY) return 'YEARLY';
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

async function syncSubscriptionToSpring(subscription) {
  // userId is stored in subscription.metadata.userId
  const userIdStr = subscription.metadata?.userId;
  if (!userIdStr) {
    console.warn('No userId in subscription metadata, skipping sync');
    return;
  }
  const userId = Number(userIdStr);
  if (!userId) return;

  const items = subscription.items?.data || [];
  const firstItem = items[0];
  const priceId = firstItem?.price?.id || null;
  const plan = mapPlanByPriceId(priceId);
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

  await axios.post(SPRING_SYNC_URL, payload, { headers });
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

// called by Spring -> Node to get a billing-portal URL
async function createPortalSession({ customerId }) {
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: process.env.STRIPE_PORTAL_RETURN_URL
  });

  return portalSession.url;
}

// called from webhook handler when we have a Subscription object
async function handleSubscriptionChange(subscription) {
  await syncSubscriptionToSpring(subscription);
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  handleSubscriptionChange
};