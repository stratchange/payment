const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const BillingCustomer = require('./models/BillingCustomer');
const BillingSubscription = require('./models/BillingSubscription');
const { persistSubscriptionFromStripe, reconcileUserSubscriptionsFromStripe } = require('./subscriptionPersistence');
const { syncSubscriptionToSpring } = require('./stripeService');

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeBillingPeriod(value) {
  const v = String(value || '').trim().toUpperCase();
  if (['YEARLY', 'YEAR', 'ANNUAL', 'ANNUEL'].includes(v)) return 'YEARLY';
  return 'MONTHLY';
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

async function findStripeSubscriptionIdForUser(userId) {
  const uid = String(userId);
  const activeRows = await BillingSubscription.find({ userId: uid, hasProAccess: true }).lean();
  const best = pickBestSubscriptionRow(activeRows);
  if (best?.stripeSubscriptionId) return best.stripeSubscriptionId;
  const row = await BillingSubscription.findOne({ userId: uid }).sort({ updatedAt: -1 }).lean();
  return row?.stripeSubscriptionId || null;
}

async function cancelStripeSubscriptionImmediately(subId) {
  if (typeof stripe.subscriptions.cancel === 'function') {
    await stripe.subscriptions.cancel(subId, { prorate: false, invoice_now: false });
  } else {
    await stripe.subscriptions.del(subId, { prorate: false });
  }
}

function isPeriodSwitch(currentPriceId, nextPriceId) {
  const monthlyId = getPriceId('MONTHLY');
  const yearlyId = getPriceId('YEARLY');
  return (
    (currentPriceId === monthlyId && nextPriceId === yearlyId) ||
    (currentPriceId === yearlyId && nextPriceId === monthlyId)
  );
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
  const monthlyId = (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim();
  const yearlyId = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  if (yearly) {
    if (!yearlyId) throw new HttpError(503, 'Prix annuel non configuré (STRIPE_PRICE_ID_YEARLY).', 'STRIPE_PLAN_NOT_CONFIGURED');
    if (monthlyId && yearlyId === monthlyId) {
      throw new HttpError(503, 'STRIPE_PRICE_ID_YEARLY et STRIPE_PRICE_ID_MONTHLY sont identiques.', 'STRIPE_PLAN_NOT_CONFIGURED');
    }
    return yearlyId;
  }
  if (!monthlyId) throw new HttpError(503, 'Prix mensuel non configuré (STRIPE_PRICE_ID_MONTHLY).', 'STRIPE_PLAN_NOT_CONFIGURED');
  return monthlyId;
}

async function resolveAndValidatePriceId(billingPeriod) {
  const priceId = getPriceId(billingPeriod);
  const expected = billingPeriod === 'YEARLY' ? 'year' : 'month';
  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    throw new HttpError(503, `Prix Stripe introuvable (${priceId}).`, 'STRIPE_PLAN_NOT_CONFIGURED');
  }
  const interval = price?.recurring?.interval || null;
  if (interval && interval !== expected) {
    throw new HttpError(
      503,
      billingPeriod === 'YEARLY'
        ? `STRIPE_PRICE_ID_YEARLY is a ${interval}ly Stripe price, not yearly. Create a recurring yearly price (€200 / year) and update STRIPE_PRICE_ID_YEARLY on the billing service.`
        : `STRIPE_PRICE_ID_MONTHLY is not a monthly Stripe price (interval=${interval}).`,
      'STRIPE_PRICE_INTERVAL_MISMATCH'
    );
  }
  return priceId;
}

async function assertSubscriptionMatchesPeriod(subscription, period) {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  let interval = typeof price === 'object' ? price?.recurring?.interval : null;
  const priceId = typeof price === 'string' ? price : price?.id;
  if (!interval && priceId) {
    try {
      const fetched = await stripe.prices.retrieve(priceId);
      interval = fetched?.recurring?.interval || null;
    } catch (err) {
      console.warn('[transport] assertSubscriptionMatchesPeriod price retrieve failed:', err?.message || err);
    }
  }
  const expected = period === 'YEARLY' ? 'year' : 'month';
  if (interval && interval !== expected) {
    console.error('[transport] subscription interval mismatch', {
      period,
      interval,
      priceId,
      subscriptionId: subscription.id,
    });
    throw new HttpError(
      500,
      'L’abonnement créé ne correspond pas à la période demandée.',
      'STRIPE_INTERVAL_MISMATCH'
    );
  }
}

async function finalizeSubscriptionFlow(refreshed, userId, expectedPeriod = null) {
  const subId = refreshed?.id ? String(refreshed.id) : null;
  const expanded = await stripe.subscriptions.retrieve(subId, {
    expand: ['latest_invoice.payment_intent', 'items.data.price'],
  });

  if (expectedPeriod) {
    await assertSubscriptionMatchesPeriod(expanded, expectedPeriod);
  }

  const pi = expanded.latest_invoice?.payment_intent;
  const piObj = typeof pi === 'string' ? null : pi;

  if (piObj && piObj.status === 'requires_action') {
    await persistSubscriptionFromStripe(expanded, String(userId), { planOverride: expectedPeriod });
    return {
      requiresAction: true,
      clientSecret: piObj.client_secret || undefined,
      subscriptionId: subId || undefined,
      pending: true,
    };
  }

  if (piObj && ['requires_payment_method', 'canceled'].includes(piObj.status)) {
    await persistSubscriptionFromStripe(expanded, String(userId), {
      planOverride: expectedPeriod,
      paymentFailed: true,
    });
    throw new HttpError(
      402,
      'Le paiement de l’abonnement a échoué ou est incomplet. Vérifiez votre carte.',
      'PAYMENT_FAILED'
    );
  }

  if (expanded.status === 'incomplete_expired') {
    await persistSubscriptionFromStripe(expanded, String(userId), {
      planOverride: expectedPeriod,
      paymentFailed: true,
    });
    throw new HttpError(
      402,
      'Le paiement de l’abonnement a échoué ou est incomplet. Vérifiez votre carte.',
      'PAYMENT_FAILED'
    );
  }

  const inv = expanded.latest_invoice && typeof expanded.latest_invoice === 'object' ? expanded.latest_invoice : null;
  const settled =
    (piObj && piObj.status === 'succeeded') ||
    String(inv?.status || '') === 'paid' ||
    ['active', 'trialing'].includes(String(expanded.status || ''));

  await persistSubscriptionFromStripe(expanded, String(userId), {
    planOverride: expectedPeriod,
    ...(settled ? { paymentConfirmed: true } : {}),
  });
  await reconcileUserSubscriptionsFromStripe(String(userId)).catch((err) => {
    console.warn('[transport] reconcile after subscribe:', err?.message || err);
  });
  await syncSubscriptionToSpring(expanded, String(userId));

  if (settled && inv?.id) {
    const { notifyMainApiSubscriptionInvoice } = require('./subscriptionInvoiceNotify');
    await notifyMainApiSubscriptionInvoice({ invoiceId: String(inv.id), outcome: 'paid' });
  }

  return { ok: true, pending: !settled, subscriptionId: subId || undefined };
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

  const period = normalizeBillingPeriod(billingPeriod);
  const priceId = await resolveAndValidatePriceId(period);
  console.info('[transport] subscribe', { userId: String(userId), billingPeriod: period, rawBillingPeriod: billingPeriod, priceId });
  const customerId = await resolveOrCreateCustomer(userId, email, fullName || '');

  await attachPaymentMethodIfNeeded(customerId, pmId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });

  const existingSubId = await findStripeSubscriptionIdForUser(userId);

  if (existingSubId) {
    let existing;
    try {
      existing = await stripe.subscriptions.retrieve(existingSubId, {
        expand: ['items.data.price'],
      });
    } catch {
      existing = null;
    }

    if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) {
      const firstItem = existing.items?.data?.[0];
      const priceObj = typeof firstItem?.price === 'object' ? firstItem.price : null;
      const currentPrice = typeof firstItem?.price === 'string' ? firstItem.price : priceObj?.id;
      const currentInterval = priceObj?.recurring?.interval || null;
      const itemId = firstItem?.id;
      const wantsYearly = period === 'YEARLY';
      const wantsMonthly = period === 'MONTHLY';
      const intervalMismatch =
        (wantsYearly && currentInterval === 'month') || (wantsMonthly && currentInterval === 'year');

      if (currentPrice === priceId && !intervalMismatch) {
        throw new HttpError(400, 'Vous êtes déjà abonné à cette période.', 'ALREADY_SUBSCRIBED');
      }

      if (isPeriodSwitch(currentPrice, priceId) || intervalMismatch) {
        await cancelStripeSubscriptionImmediately(existingSubId);
        const canceled = await stripe.subscriptions.retrieve(existingSubId);
        await persistSubscriptionFromStripe(canceled, String(userId));
      } else {
        if (!itemId) throw new HttpError(500, 'Impossible de mettre à jour l’abonnement.', 'STRIPE_ERROR');
        await stripe.subscriptions.update(existingSubId, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
          cancel_at_period_end: false,
          // Reset cycle so YEARLY gets a year-long period (not the leftover monthly end).
          billing_cycle_anchor: 'now',
          default_payment_method: pmId,
          metadata: {
            ...(existing.metadata || {}),
            userId: String(userId),
            billingPeriod: period,
          },
        });
        const expanded = await stripe.subscriptions.retrieve(existingSubId, {
          expand: ['latest_invoice.payment_intent', 'items.data.price'],
        });
        return finalizeSubscriptionFlow(expanded, userId, period);
      }
    }
  }

  const meta = { userId: String(userId), billingPeriod: period };
  if (planId) meta.planId = String(planId);
  if (planName) meta.planName = String(planName);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    default_payment_method: pmId,
    metadata: meta,
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent', 'items.data.price'],
  });

  return finalizeSubscriptionFlow(subscription, userId, period);
};

exports.transportConfirmPayment = async ({ userId, subscriptionId }) => {
  const subId = String(subscriptionId || '').trim();
  if (!subId) throw new HttpError(400, 'subscriptionId est requis.', 'VALIDATION_ERROR');

  const refreshed = await stripe.subscriptions.retrieve(subId, {
    expand: ['latest_invoice.payment_intent', 'items.data.price'],
  });

  const metaUid = refreshed.metadata?.userId ? String(refreshed.metadata.userId) : null;
  if (metaUid && String(userId) !== metaUid) {
    throw new HttpError(403, 'Cet abonnement n’appartient pas à cet utilisateur.', 'FORBIDDEN');
  } else if (!metaUid) {
    const own = await findStripeSubscriptionIdForUser(userId);
    if (own !== subId) throw new HttpError(403, 'Abonnement incohérent.', 'FORBIDDEN');
  }

  if (['canceled', 'unpaid', 'incomplete_expired'].includes(refreshed.status)) {
    await persistSubscriptionFromStripe(refreshed, String(userId), { paymentFailed: true });
    throw new HttpError(400, 'L’abonnement n’est pas actif.', 'VALIDATION_ERROR');
  }

  const metaPeriod = refreshed.metadata?.billingPeriod;
  const planOverride =
    metaPeriod === 'YEARLY' || metaPeriod === 'MONTHLY' ? metaPeriod : undefined;
  const inv = refreshed.latest_invoice && typeof refreshed.latest_invoice === 'object' ? refreshed.latest_invoice : null;
  const pi = inv?.payment_intent;
  const piObj = pi && typeof pi === 'object' ? pi : null;
  const settled =
    (piObj && piObj.status === 'succeeded') ||
    String(inv?.status || '') === 'paid' ||
    ['active', 'trialing'].includes(String(refreshed.status || ''));

  await persistSubscriptionFromStripe(refreshed, String(userId), {
    planOverride,
    ...(settled ? { paymentConfirmed: true } : {}),
  });
  await syncSubscriptionToSpring(refreshed, String(userId));
  return { ok: true, pending: !settled, subscriptionId: subId };
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
    throw new HttpError(502, 'Impossible d’annuler l’abonnement Stripe.', 'STRIPE_CANCEL_FAILED');
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
