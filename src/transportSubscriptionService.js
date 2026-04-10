const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const BillingCustomer = require('./models/BillingCustomer');
const BillingSubscription = require('./models/BillingSubscription');
const { persistSubscriptionFromStripe } = require('./subscriptionPersistence');
const { syncSubscriptionToSpring } = require('./stripeService');

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function formatCardBrandForApi(brand) {
  if (!brand) return 'Carte';
  const b = String(brand).toLowerCase();
  const map = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    diners: 'Diners Club',
    jcb: 'JCB',
    unionpay: 'UnionPay',
  };
  return map[b] || String(brand).charAt(0).toUpperCase() + String(brand).slice(1);
}

async function resolveOrCreateCustomer(userId, email, fullName) {
  const uid = String(userId);
  let row = await BillingCustomer.findOne({ userId: uid });
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await stripe.customers.create({
    email,
    name: fullName || undefined,
    metadata: { userId: uid },
  });

  await BillingCustomer.findOneAndUpdate(
    { userId: uid },
    { $set: { stripeCustomerId: customer.id, email } },
    { upsert: true, new: true }
  );
  return customer.id;
}

async function findStripeSubscriptionIdForUser(userId) {
  const uid = String(userId);
  let row = await BillingSubscription.findOne({ userId: uid, hasProAccess: true }).lean();
  if (row?.stripeSubscriptionId) return row.stripeSubscriptionId;
  row = await BillingSubscription.findOne({ userId: uid }).sort({ updatedAt: -1 }).lean();
  return row?.stripeSubscriptionId || null;
}

/** Attache seulement si la PM n’est pas déjà sur ce client (ré-abonnement avec carte enregistrée). */
async function attachPaymentMethodIfNeeded(customerId, pmId) {
  const pm = await stripe.paymentMethods.retrieve(pmId);
  const existing = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || null;
  if (existing === customerId) return;
  if (existing) {
    throw new HttpError(400, 'Ce moyen de paiement est lié à un autre compte.', 'STRIPE_PM_CUSTOMER_MISMATCH');
  }
  await stripe.paymentMethods.attach(pmId, { customer: customerId });
}

function getPriceId(billingPeriod) {
  const yearly = billingPeriod === 'YEARLY';
  if (yearly) {
    const id = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
    if (!id) throw new HttpError(503, 'Prix annuel non configuré (STRIPE_PRICE_ID_YEARLY).', 'STRIPE_PLAN_NOT_CONFIGURED');
    return id;
  }
  const id = (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim();
  if (!id) throw new HttpError(503, 'Prix mensuel non configuré (STRIPE_PRICE_ID_MONTHLY).', 'STRIPE_PLAN_NOT_CONFIGURED');
  return id;
}

async function finalizeSubscriptionFlow(refreshed, userId) {
  const subId = refreshed?.id ? String(refreshed.id) : null;
  const expanded = await stripe.subscriptions.retrieve(subId, {
    expand: ['latest_invoice.payment_intent'],
  });

  const pi = expanded.latest_invoice?.payment_intent;
  const piObj = typeof pi === 'string' ? null : pi;

  if (piObj && piObj.status === 'requires_action') {
    return {
      requiresAction: true,
      clientSecret: piObj.client_secret || undefined,
      subscriptionId: subId || undefined,
    };
  }

  if (['incomplete', 'incomplete_expired'].includes(expanded.status)) {
    throw new HttpError(
      402,
      'Le paiement de l’abonnement a échoué ou est incomplet. Vérifiez votre carte.',
      'PAYMENT_FAILED'
    );
  }

  await persistSubscriptionFromStripe(expanded, String(userId));
  await syncSubscriptionToSpring(expanded, String(userId));
  return { ok: true, subscriptionId: subId || undefined };
}

exports.transportSetupIntent = async ({ userId, email, fullName }) => {
  if (!userId || !email) throw new HttpError(400, 'userId et email sont requis.', 'VALIDATION_ERROR');
  const customerId = await resolveOrCreateCustomer(userId, email, fullName || '');
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { userId: String(userId), purpose: 'subscription' },
  });
  if (!setupIntent.client_secret) {
    throw new HttpError(503, 'Le prestataire de paiement n’a pas renvoyé le secret SetupIntent.', 'STRIPE_ERROR');
  }
  return { clientSecret: setupIntent.client_secret };
};

exports.transportGetDefaultCard = async ({ userId }) => {
  if (!userId) throw new HttpError(400, 'userId est requis.', 'VALIDATION_ERROR');
  const uid = String(userId);
  const row = await BillingCustomer.findOne({ userId: uid }).lean();
  const customerId = row?.stripeCustomerId;
  if (!customerId) return { card: null, paymentMethodId: null };

  const customer = await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  });
  if (customer.deleted) return { card: null, paymentMethodId: null };

  let pm = customer.invoice_settings?.default_payment_method;
  if (typeof pm === 'string') pm = await stripe.paymentMethods.retrieve(pm);

  if (!pm || pm.type !== 'card') {
    const subId = await findStripeSubscriptionIdForUser(uid);
    if (subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId, { expand: ['default_payment_method'] });
        let pm2 = sub.default_payment_method;
        if (typeof pm2 === 'string') pm2 = await stripe.paymentMethods.retrieve(pm2);
        if (pm2 && pm2.type === 'card') pm = pm2;
      } catch (err) {
        console.warn('[transport] default card subscription fallback:', err?.message || err);
      }
    }
  }

  if (!pm || pm.type !== 'card' || !pm.card) {
    try {
      const listed = await stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 3 });
      const first = listed?.data?.find((x) => x.type === 'card' && x.card);
      if (first && first.type === 'card') pm = first;
    } catch (err) {
      console.warn('[transport] listPaymentMethods fallback:', err?.message || err);
    }
  }

  if (!pm || pm.type !== 'card' || !pm.card) return { card: null, paymentMethodId: null };

  const card = pm.card;
  return {
    card: {
      brand: formatCardBrandForApi(card.brand),
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
    },
    paymentMethodId: pm.id || null,
  };
};

exports.transportSetDefaultPaymentMethod = async ({ userId, email, fullName, paymentMethodId }) => {
  const pmId = String(paymentMethodId || '').trim();
  if (!pmId) throw new HttpError(400, 'paymentMethodId est requis.', 'VALIDATION_ERROR');
  if (!userId || !email) throw new HttpError(400, 'userId et email sont requis.', 'VALIDATION_ERROR');

  const customerId = await resolveOrCreateCustomer(userId, email, fullName || '');
  await attachPaymentMethodIfNeeded(customerId, pmId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });

  const subId = await findStripeSubscriptionIdForUser(userId);
  if (subId) {
    try {
      await stripe.subscriptions.update(subId, { default_payment_method: pmId });
    } catch (err) {
      console.warn('[transport] subscription default_pm update:', err?.message || err);
    }
  }
  return { ok: true };
};

exports.transportSubscribe = async ({ userId, email, fullName, billingPeriod, paymentMethodId, planId, planName }) => {
  const pmId = String(paymentMethodId || '').trim();
  if (!pmId) throw new HttpError(400, 'paymentMethodId est requis.', 'VALIDATION_ERROR');
  if (!userId || !email) throw new HttpError(400, 'userId et email sont requis.', 'VALIDATION_ERROR');

  const period = billingPeriod === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
  const priceId = getPriceId(period);
  const customerId = await resolveOrCreateCustomer(userId, email, fullName || '');

  await attachPaymentMethodIfNeeded(customerId, pmId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });

  const existingSubId = await findStripeSubscriptionIdForUser(userId);

  if (existingSubId) {
    let existing;
    try {
      existing = await stripe.subscriptions.retrieve(existingSubId);
    } catch {
      existing = null;
    }

    if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) {
      const currentPrice = existing.items?.data?.[0]?.price?.id;
      const itemId = existing.items?.data?.[0]?.id;
      if (currentPrice === priceId) {
        throw new HttpError(400, 'Vous êtes déjà abonné à cette période.', 'ALREADY_SUBSCRIBED');
      }
      if (!itemId) throw new HttpError(500, 'Impossible de mettre à jour l’abonnement.', 'STRIPE_ERROR');

      await stripe.subscriptions.update(existingSubId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
        default_payment_method: pmId,
      });
      const expanded = await stripe.subscriptions.retrieve(existingSubId, {
        expand: ['latest_invoice.payment_intent'],
      });
      return finalizeSubscriptionFlow(expanded, userId);
    }
  }

  const meta = { userId: String(userId) };
  if (planId) meta.planId = String(planId);
  if (planName) meta.planName = String(planName);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    default_payment_method: pmId,
    metadata: meta,
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
  });

  return finalizeSubscriptionFlow(subscription, userId);
};

exports.transportConfirmPayment = async ({ userId, subscriptionId }) => {
  const subId = String(subscriptionId || '').trim();
  if (!subId) throw new HttpError(400, 'subscriptionId est requis.', 'VALIDATION_ERROR');

  const refreshed = await stripe.subscriptions.retrieve(subId, {
    expand: ['latest_invoice.payment_intent'],
  });

  const metaUid = refreshed.metadata?.userId ? String(refreshed.metadata.userId) : null;
  if (metaUid && String(userId) !== metaUid) {
    throw new HttpError(403, 'Cet abonnement n’appartient pas à cet utilisateur.', 'FORBIDDEN');
  } else if (!metaUid) {
    const own = await findStripeSubscriptionIdForUser(userId);
    if (own !== subId) throw new HttpError(403, 'Abonnement incohérent.', 'FORBIDDEN');
  }

  if (['canceled', 'unpaid'].includes(refreshed.status)) {
    throw new HttpError(400, 'L’abonnement n’est pas actif.', 'VALIDATION_ERROR');
  }
  if (refreshed.status === 'incomplete') {
    throw new HttpError(400, 'Paiement encore incomplet. Finalisez l’authentification.', 'PAYMENT_INCOMPLETE');
  }

  await persistSubscriptionFromStripe(refreshed, String(userId));
  await syncSubscriptionToSpring(refreshed, String(userId));
  return { ok: true, subscriptionId: subId };
};

exports.transportPortal = async ({ userId }) => {
  if (!userId) throw new HttpError(400, 'userId est requis.', 'VALIDATION_ERROR');
  const row = await BillingCustomer.findOne({ userId: String(userId) }).lean();
  const customerId = row?.stripeCustomerId;
  if (!customerId) throw new HttpError(400, 'Aucun client de facturation. Abonnez-vous d’abord.', 'VALIDATION_ERROR');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: process.env.STRIPE_PORTAL_RETURN_URL || 'http://localhost:8080/transporter/subscription',
  });
  return { url: session.url };
};

exports.transportCancel = async ({ userId }) => {
  if (!userId) throw new HttpError(400, 'userId est requis.', 'VALIDATION_ERROR');
  const subId = await findStripeSubscriptionIdForUser(userId);

  if (!subId) {
    return { cancelled: false, reason: 'NO_SUBSCRIPTION_ID' };
  }

  try {
    if (typeof stripe.subscriptions.cancel === 'function') {
      await stripe.subscriptions.cancel(subId, { prorate: false, invoice_now: false });
    } else {
      await stripe.subscriptions.del(subId, { prorate: false });
    }
  } catch (err) {
    console.error('[transport] cancel subscription:', err?.message || err);
  }

  let refreshed;
  try {
    refreshed = await stripe.subscriptions.retrieve(subId);
  } catch {
    refreshed = {
             id: subId,
             status: 'canceled',
             metadata: { userId: String(userId) },
             items: { data: [] },
             customer: (await BillingCustomer.findOne({ userId: String(userId) }))?.stripeCustomerId,
           };
  }

  await persistSubscriptionFromStripe(refreshed, String(userId)).catch(() => {});
  await syncSubscriptionToSpring(refreshed, String(userId));
  return { cancelled: true, subscriptionId: subId };
};

exports.transportSubscriptionCheckoutSession = async ({ userId, email, priceId, planId, planName }) => {
  if (!userId || !email || !priceId) {
    throw new HttpError(400, 'userId, email et priceId sont requis.', 'VALIDATION_ERROR');
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: process.env.STRIPE_SUCCESS_URL,
    cancel_url: process.env.STRIPE_CANCEL_URL,
    customer_email: email,
    client_reference_id: String(userId),
    metadata: {
      type: 'subscription',
      userId: String(userId),
      ...(planId ? { planId: String(planId) } : {}),
      ...(planName ? { planName: String(planName) } : {}),
    },
    subscription_data: {
      metadata: {
        userId: String(userId),
        ...(planId ? { planId: String(planId) } : {}),
        ...(planName ? { planName: String(planName) } : {}),
      },
    },
  });
  return { url: session.url, sessionId: session.id };
};

exports.transportConfirmCheckoutSession = async ({ userId, sessionId }) => {
  if (!sessionId || !userId) throw new HttpError(400, 'sessionId et userId sont requis.', 'VALIDATION_ERROR');

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== 'subscription') {
    throw new HttpError(400, 'Session non abonnement.', 'VALIDATION_ERROR');
  }
  const paid =
    session.payment_status === 'paid' ||
    session.status === 'complete' ||
    (session.payment_status === 'no_payment_required' && session.status === 'complete');
  if (!paid) throw new HttpError(400, 'Paiement non finalisé.', 'VALIDATION_ERROR');

  const metaUser = session.metadata?.userId || session.client_reference_id || null;
  if (metaUser && String(metaUser) !== String(userId)) {
    throw new HttpError(403, 'Session invalide pour cet utilisateur.', 'FORBIDDEN');
  }

  const planId = session.metadata?.planId;
  const custRaw = session.customer;
  const stripeCustomerId = typeof custRaw === 'string' ? custRaw : custRaw?.id || null;
  const subRaw = session.subscription;
  const stripeSubscriptionId = typeof subRaw === 'string' ? subRaw : subRaw?.id || null;

  const applyUrl = (process.env.SHIPPIZY_APPLY_CHECKOUT_URL || '').trim();
  const headers = {};
  if (process.env.SPRING_SYNC_API_KEY) {
    headers['X-Internal-Api-Key'] = process.env.SPRING_SYNC_API_KEY;
  }

  if (planId && applyUrl) {
    try {
      await axios.post(
        applyUrl,
        {
          userId: String(userId),
          planId: String(planId),
          stripeCustomerId,
          stripeSubscriptionId,
        },
        { headers }
      );
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
      throw new HttpError(502, `apply-checkout: ${msg}`, 'APPLY_CHECKOUT_FAILED');
    }
  } else if (planId && !applyUrl) {
    console.warn('[transport] Session has planId but SHIPPIZY_APPLY_CHECKOUT_URL is not set — main DB plan link may be missing.');
  }

  if (stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await persistSubscriptionFromStripe(sub, String(userId));
    await syncSubscriptionToSpring(sub, String(userId));
  }

  return { ok: true };
};

exports.HttpError = HttpError;
