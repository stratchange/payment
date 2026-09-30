const axios = require('axios');
const {
  BookingPayment,
  LedgerEntry,
  CarrierWallet,
  CarrierMonthStatement,
  CommissionInvoice,
  ConnectedAccount,
  CarrierPaymentPreference,
  PlatformFeeSetting,
  CarrierPayoutAccount,
  CarrierCommissionCard,
} = require('./models/booking');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function stripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED', 'Stripe is not configured.');
  return require('stripe')(key);
}

function quoteCommission(amountCents, feesEnabled) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'amountCents must be a non-negative integer.');
  }
  if (!feesEnabled) {
    return { commissionCents: 0, netCents: amount, feesEnabled: false };
  }
  if (amount < 149) {
    throw new HttpError(400, 'AMOUNT_BELOW_COMMISSION_FLOOR', 'Booking amount is below the commission floor.');
  }
  const commissionCents = Math.max(149, Math.min(1500, Math.round(amount * 0.05)));
  return { commissionCents, netCents: amount - commissionCents, feesEnabled: true };
}

function parisParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = fmt.format(date).split('-');
  return { year: Number(year), month: Number(month), day: Number(day), period: `${year}-${month}` };
}

function isLastParisDay(date = new Date()) {
  const { year, month, day } = parisParts(date);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === last;
}

async function loadSnapshot(reservationId) {
  const base = (process.env.BACKEND_INTERNAL_BASE_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    throw new HttpError(503, 'BACKEND_NOT_CONFIGURED', 'BACKEND_INTERNAL_BASE_URL is not set.');
  }
  const origin = base.replace(/\/api\/v1$/, '');
  const url = `${origin}/api/v1/internal/reservations/${encodeURIComponent(reservationId)}`;
  const headers = {};
  if (process.env.SPRING_SYNC_API_KEY) headers['X-Internal-Api-Key'] = process.env.SPRING_SYNC_API_KEY;
  const res = await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
  if (res.status === 404) throw new HttpError(404, 'NOT_FOUND', 'Reservation not found.');
  if (res.status < 200 || res.status >= 300 || !res.data) {
    throw new HttpError(502, 'BACKEND_ERROR', 'Failed to read reservation.');
  }
  return res.data;
}

async function feesEnabled() {
  const row = await PlatformFeeSetting.findOne({ key: 'platform' }).lean();
  return Boolean(row?.enablePlatformFees);
}

async function preferenceView(userId) {
  const pref = await CarrierPaymentPreference.findOne({ userId: String(userId) }).lean();
  const account = await ConnectedAccount.findOne({ userId: String(userId) }).lean();
  if (!pref) {
    return { acceptCash: true, acceptOnline: false, onlineReady: false };
  }
  return {
    acceptCash: pref.acceptCash !== false,
    acceptOnline: pref.acceptOnline === true,
    onlineReady: Boolean(account?.chargesEnabled),
  };
}

async function assertMethodAccepted(transporterId, paymentMethod) {
  const prefs = await preferenceView(transporterId);
  if (paymentMethod === 'CASH' && !prefs.acceptCash) {
    throw new HttpError(400, 'PAYMENT_METHOD_NOT_ACCEPTED', 'Carrier does not accept cash.');
  }
  if (paymentMethod === 'ONLINE' && (!prefs.acceptOnline || !prefs.onlineReady)) {
    throw new HttpError(400, 'PAYMENT_METHOD_NOT_ACCEPTED', 'Carrier does not accept card.');
  }
}

async function carrierIsHeld(transporterId) {
  const overdue = await CommissionInvoice.findOne({
    transporterId: String(transporterId),
    status: 'OPEN',
    dueAt: { $lt: new Date() },
  }).lean();
  return Boolean(overdue);
}

async function applyLedger({ reservationId, tripId, transporterId, cycle, type, bucket, cents, walletInc, statementInc, period }) {
  const existing = await LedgerEntry.findOne({ reservationId, type, cycle }).lean();
  if (existing) return existing;
  try {
    await LedgerEntry.create({
      reservationId,
      tripId: tripId || null,
      transporterId,
      cycle,
      type,
      bucket,
      cents,
    });
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
  if (walletInc) {
    await CarrierWallet.updateOne(
      { transporterId },
      { $inc: walletInc, $setOnInsert: { transporterId } },
      { upsert: true }
    );
  }
  if (statementInc && period) {
    await CarrierMonthStatement.updateOne(
      { transporterId, period },
      { $inc: statementInc, $setOnInsert: { transporterId, period } },
      { upsert: true }
    );
  }
  return null;
}

async function clientSecretFor(row) {
  if (!row?.stripePaymentIntentId || row.status !== 'UNPAID') return null;
  const pi = await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId);
  return pi.client_secret || null;
}

function publicRow(row, clientSecret) {
  return {
    reservationId: row.reservationId,
    status: row.status,
    amountCents: row.amountCents,
    commissionCents: row.commissionCents,
    netCents: row.netCents,
    paymentMethod: row.paymentMethod,
    clientSecret: clientSecret == null ? null : clientSecret,
  };
}

async function freezeQuote(snapshot) {
  const on = await feesEnabled();
  const currency = String(snapshot.currency || 'EUR').toUpperCase();
  const amountCents = Number(snapshot.amountCents);
  const method = String(snapshot.paymentMethod || '').toUpperCase();
  if (method !== 'CASH' && method !== 'ONLINE') {
    throw new HttpError(400, 'PAYMENT_METHOD_NOT_ACCEPTED', 'paymentMethod must be CASH or ONLINE.');
  }
  if (snapshot.isStaticTemplate === true) {
    return {
      commissionCents: 0,
      netCents: 0,
      feesEnabled: false,
      currency: currency || 'EUR',
      paymentMethod: method,
      status: 'NONE',
    };
  }
  if (on && currency !== 'EUR') {
    throw new HttpError(400, 'CURRENCY_NOT_SUPPORTED', 'Only EUR bookings are charged a commission.');
  }
  const quote = quoteCommission(Number.isFinite(amountCents) ? amountCents : 0, on);
  let status = 'NONE';
  if (on && method === 'CASH') status = 'PENDING';
  if (on && method === 'ONLINE') status = 'UNPAID';
  return { ...quote, currency: on ? 'EUR' : currency, paymentMethod: method, status };
}

async function opened(reservationId) {
  const snapshot = await loadSnapshot(reservationId);
  if (snapshot.manual === true) {
    throw new HttpError(409, 'MANUAL_BOOKING', 'Manual bookings are not charged.');
  }
  const method = String(snapshot.paymentMethod || '').toUpperCase();
  await assertMethodAccepted(snapshot.transporterId, method);

  let row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  const reopen = row && row.status === 'VOID' && String(snapshot.status || '').toUpperCase() === 'PENDING';
  if (row && !reopen) {
    return publicRow(row, null);
  }

  const quote = await freezeQuote(snapshot);
  const cycle = reopen ? Number(row.cycle || 1) + 1 : 1;
  const base = {
    reservationId: String(reservationId),
    tripId: snapshot.tripId ? String(snapshot.tripId) : null,
    transporterId: String(snapshot.transporterId),
    expeditorId: snapshot.expeditorId ? String(snapshot.expeditorId) : null,
    amountCents: Number(snapshot.amountCents),
    commissionCents: quote.commissionCents,
    netCents: quote.netCents,
    currency: quote.currency,
    paymentMethod: quote.paymentMethod,
    status: quote.status,
    cycle,
    stripePaymentIntentId: null,
    stripeTransferId: null,
    stripeRefundId: null,
    invoiceId: null,
    deliveredAt: null,
  };
  if (reopen) {
    Object.assign(row, base);
    await row.save();
  } else {
    row = await BookingPayment.create(base);
  }
  return publicRow(row, null);
}

async function chargeSettlement(stripe, pi) {
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) return null;
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const txn = charge.balance_transaction;
  if (!txn || typeof txn === 'string') return { chargeId, currency: 'eur', gross: null, net: null };
  return {
    chargeId,
    currency: String(txn.currency || 'eur').toLowerCase(),
    gross: Number(txn.amount),
    net: Number(txn.net),
  };
}

function netTransferForSettlement(row, settlement) {
  const bookingNet = Number(row.netCents);
  const bookingGross = Number(row.amountCents);
  if (!settlement || settlement.currency === 'eur' || !(settlement.gross > 0) || !(bookingGross > 0)) {
    return { amount: bookingNet, currency: 'eur' };
  }
  let amount = Math.round((settlement.gross * bookingNet) / bookingGross);
  if (settlement.net > 0 && amount > settlement.net) amount = settlement.net;
  return { amount, currency: settlement.currency };
}

async function settlePlatformCharge(row) {
  if (!row?.stripePaymentIntentId || row.stripeTransferId || !(Number(row.netCents) > 0)) return row;
  const stripe = stripeClient();
  const pi = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);
  if (pi.status !== 'succeeded' || pi.transfer_data?.destination) return row;
  const connected = await ConnectedAccount.findOne({ userId: row.transporterId });
  if (!connected?.stripeAccountId) return row;
  const account = await stripe.accounts.retrieve(connected.stripeAccountId);
  connected.chargesEnabled = Boolean(account.charges_enabled);
  connected.payoutsEnabled = Boolean(account.payouts_enabled);
  await connected.save();
  if (account.capabilities?.transfers !== 'active') return row;
  await keepPayoutsManual(stripe, connected.stripeAccountId);
  const settlement = await chargeSettlement(stripe, pi);
  const { amount, currency } = netTransferForSettlement(row, settlement);
  if (!(amount > 0)) return row;
  const transfer = await stripe.transfers.create(
    {
      amount,
      currency,
      destination: connected.stripeAccountId,
      transfer_group: row.reservationId,
      ...(settlement?.chargeId ? { source_transaction: settlement.chargeId } : {}),
    },
    { idempotencyKey: `transfer:${row.reservationId}:${row.cycle || 1}:settle:${currency}` }
  );
  row.stripeTransferId = transfer.id;
  if (row.status === 'UNPAID') row.status = 'HELD';
  await row.save();
  return row;
}

async function ensureOnlineIntent(row) {
  if (row.paymentMethod !== 'ONLINE' || row.status === 'NONE') return row;
  if (row.stripePaymentIntentId) {
    const stripe = stripeClient();
    const existing = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);
    if (existing.status === 'succeeded' || existing.transfer_data?.destination) return row;
    const cancellable = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'];
    if (cancellable.includes(existing.status)) {
      await stripe.paymentIntents.cancel(existing.id);
      row.stripePaymentIntentId = null;
      await row.save();
    } else {
      return row;
    }
  }
  const account = await ConnectedAccount.findOne({ userId: row.transporterId }).lean();
  if (!account?.stripeAccountId) {
    throw new HttpError(409, 'CONNECT_REQUIRED', 'Carrier has no connected account.');
  }
  const stripe = stripeClient();
  await keepPayoutsManual(stripe, account.stripeAccountId);
  const params = {
    amount: row.amountCents,
    currency: 'eur',
    transfer_group: row.reservationId,
    metadata: {
      reservationId: row.reservationId,
      transporterId: row.transporterId,
      commissionCents: String(row.commissionCents),
      cycle: String(row.cycle || 1),
    },
    automatic_payment_methods: { enabled: true },
  };
  if (row.netCents > 0) {
    params.transfer_data = { destination: account.stripeAccountId };
    if (row.commissionCents > 0) params.application_fee_amount = row.commissionCents;
  }
  const pi = await stripe.paymentIntents.create(params, {
    idempotencyKey: `pi:${row.reservationId}:${row.cycle || 1}:dest`,
  });
  row.stripePaymentIntentId = pi.id;
  if (row.status !== 'HELD' && row.status !== 'PAID' && row.status !== 'VOID') {
    row.status = 'UNPAID';
  }
  await row.save();
  return row;
}

async function confirm(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  if (await carrierIsHeld(row.transporterId)) {
    throw new HttpError(409, 'PAYMENT_DUE', 'Unpaid commission invoice.');
  }
  if (row.status === 'NONE' || row.status === 'PENDING' || row.paymentMethod === 'CASH') {
    return { reservationId: row.reservationId, status: row.status, allowed: true };
  }
  await ensureOnlineIntent(row);
  return { reservationId: row.reservationId, status: row.status, allowed: true };
}

async function pay(reservationId) {
  let row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  if (row.paymentMethod !== 'ONLINE') {
    const snapshot = await loadSnapshot(reservationId);
    if (String(snapshot.paymentMethod || '').toUpperCase() === 'ONLINE' && row.status === 'PENDING') {
      row.paymentMethod = 'ONLINE';
      row.status = 'UNPAID';
      await row.save();
    }
  }
  if (row.paymentMethod !== 'ONLINE') {
    throw new HttpError(409, 'CASH_BOOKING', 'This reservation is paid in cash.');
  }
  if (row.status === 'HELD' || row.status === 'PAID') {
    await settlePlatformCharge(row);
    return publicRow(row, null);
  }
  row = await ensureOnlineIntent(row);
  await settlePlatformCharge(row);
  if (row.status === 'HELD' || row.status === 'PAID') {
    return publicRow(row, null);
  }
  if (row.status !== 'UNPAID' || !row.stripePaymentIntentId) {
    throw new HttpError(409, 'INVALID_PAYMENT_STATE', 'Online payment cannot be started.');
  }
  const secret = await clientSecretFor(row);
  return publicRow(row, secret);
}

async function syncSucceededIntent(row) {
  if (!row?.stripePaymentIntentId || row.paymentMethod !== 'ONLINE' || row.status !== 'UNPAID') return row;
  try {
    const pi = await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId);
    if (pi.status !== 'succeeded') return row;
    row.status = 'HELD';
    await row.save();
    try {
      await settlePlatformCharge(row);
    } catch (err) {
      console.error('[booking.sync]', err?.message || err);
    }
  } catch (err) {
    console.error('[booking.sync]', err?.message || err);
  }
  return row;
}

async function getBooking(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  await syncSucceededIntent(row);
  const secret = await clientSecretFor(row);
  return publicRow(row, secret);
}

function adminPaymentRow(row) {
  return {
    reservationId: row.reservationId,
    tripId: row.tripId || null,
    amountCents: Number(row.amountCents) || 0,
    commissionCents: Number(row.commissionCents) || 0,
    netCents: Number(row.netCents) || 0,
    currency: row.currency || 'EUR',
    paymentMethod: row.paymentMethod,
    status: row.status,
    invoiceId: row.invoiceId || null,
    deliveredAt: row.deliveredAt || null,
  };
}

async function adminReservationPayment(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) }).lean();
  return { payment: row ? adminPaymentRow(row) : null };
}

async function adminTripPayments(tripId) {
  const rows = await BookingPayment.find({ tripId: String(tripId) }).sort({ createdAt: -1 }).lean();
  const items = rows.map(adminPaymentRow);
  const totals = items.reduce(
    (acc, item) => {
      acc.amountCents += item.amountCents;
      acc.commissionCents += item.commissionCents;
      acc.netCents += item.netCents;
      return acc;
    },
    { amountCents: 0, commissionCents: 0, netCents: 0 },
  );
  return { tripId: String(tripId), currency: 'EUR', count: items.length, ...totals, items };
}

async function requirePaid(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  if (row.status === 'NONE' || row.paymentMethod === 'CASH') {
    return { reservationId: row.reservationId, status: row.status, allowed: true };
  }
  if (row.status !== 'HELD' && row.status !== 'PAID') {
    throw new HttpError(409, 'NOT_PAID', 'Online payment is not held.');
  }
  return { reservationId: row.reservationId, status: row.status, allowed: true };
}

async function delivered(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  if (row.status === 'VOID') {
    throw new HttpError(409, 'INVALID_PAYMENT_STATE', 'Booking is void.');
  }
  if (row.status === 'PAID' || row.status === 'MONTHLY_INVOICED') {
    return {
      reservationId: row.reservationId,
      status: row.status,
      commissionCents: row.commissionCents,
      netCents: row.netCents,
    };
  }
  if (row.status === 'NONE') {
    return {
      reservationId: row.reservationId,
      status: row.status,
      commissionCents: row.commissionCents,
      netCents: row.netCents,
    };
  }
  if (row.paymentMethod === 'CASH' && row.status === 'PENDING') {
    row.deliveredAt = row.deliveredAt || new Date();
    await row.save();
    const period = parisParts(row.deliveredAt).period;
    await applyLedger({
      reservationId: row.reservationId,
      tripId: row.tripId,
      transporterId: row.transporterId,
      cycle: row.cycle,
      type: 'CASH_DEBT',
      bucket: 'cashDue',
      cents: row.commissionCents,
      walletInc: { cashDueCents: row.commissionCents, commissionCents: row.commissionCents },
      statementInc: { commissionCents: row.commissionCents, cashCommissionCents: row.commissionCents },
      period,
    });
    await applyLedger({
      reservationId: row.reservationId,
      tripId: row.tripId,
      transporterId: row.transporterId,
      cycle: row.cycle,
      type: 'CASH_GAIN',
      bucket: 'gain',
      cents: row.netCents,
      walletInc: { totalGainCents: row.netCents },
      statementInc: { gainCents: row.netCents },
      period,
    });
    return {
      reservationId: row.reservationId,
      status: row.status,
      commissionCents: row.commissionCents,
      netCents: row.netCents,
    };
  }
  if (row.paymentMethod !== 'ONLINE' || row.status !== 'HELD') {
    throw new HttpError(409, 'INVALID_PAYMENT_STATE', 'Online booking is not held.');
  }
  await settlePlatformCharge(row);
  const paidIntent = row.stripePaymentIntentId
    ? await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId)
    : null;
  const onConnect = Boolean(row.stripeTransferId || paidIntent?.transfer_data?.destination);
  if (row.netCents > 0 && !onConnect) {
    throw new HttpError(409, 'CONNECT_REQUIRED', 'The connected account cannot receive the carrier net yet.');
  }
  const period = parisParts().period;
  await applyLedger({
    reservationId: row.reservationId,
    tripId: row.tripId,
    transporterId: row.transporterId,
    cycle: row.cycle,
    type: 'NET_CREDIT',
    bucket: 'available',
    cents: row.netCents,
    walletInc: { availableToWithdrawCents: row.netCents, totalGainCents: row.netCents },
    statementInc: { gainCents: row.netCents },
    period,
  });
  await applyLedger({
    reservationId: row.reservationId,
    tripId: row.tripId,
    transporterId: row.transporterId,
    cycle: row.cycle,
    type: 'COMMISSION',
    bucket: 'platform',
    cents: row.commissionCents,
    walletInc: { commissionCents: row.commissionCents },
    statementInc: { commissionCents: row.commissionCents, onlineCommissionCents: row.commissionCents },
    period,
  });
  row.status = 'PAID';
  row.deliveredAt = row.deliveredAt || new Date();
  await row.save();
  return {
    reservationId: row.reservationId,
    status: row.status,
    commissionCents: row.commissionCents,
    netCents: row.netCents,
  };
}

async function cancelIntent(row) {
  if (!row.stripePaymentIntentId) return;
  const stripe = stripeClient();
  const pi = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);
  const cancellable = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
  if (cancellable.includes(pi.status)) {
    await stripe.paymentIntents.cancel(row.stripePaymentIntentId);
  }
}

async function refundSender(row) {
  if (!row.stripePaymentIntentId || row.stripeRefundId) return;
  const refund = await stripeClient().refunds.create(
    {
      payment_intent: row.stripePaymentIntentId,
      amount: row.amountCents,
      ...(row.netCents > 0 ? { reverse_transfer: true } : {}),
      ...(row.commissionCents > 0 ? { refund_application_fee: true } : {}),
    },
    { idempotencyKey: `refund:${row.reservationId}:${row.cycle || 1}` }
  );
  row.stripeRefundId = refund.id;
}

async function voidBooking(reservationId) {
  const row = await BookingPayment.findOne({ reservationId: String(reservationId) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Booking payment not found.');
  if (row.status === 'VOID') {
    return { reservationId: row.reservationId, status: 'VOID' };
  }
  if (row.status === 'NONE') {
    row.status = 'VOID';
    await row.save();
    return { reservationId: row.reservationId, status: 'VOID' };
  }

  const period = parisParts(row.deliveredAt || new Date()).period;
  if (row.paymentMethod === 'ONLINE' && (row.status === 'UNPAID' || row.status === 'HELD' || row.status === 'PAID')) {
    if (row.status === 'UNPAID') {
      await cancelIntent(row);
    } else if (row.status === 'HELD') {
      await refundSender(row);
    } else if (row.status === 'PAID') {
      const wallet = await CarrierWallet.findOne({ transporterId: row.transporterId }).lean();
      const available = wallet?.availableToWithdrawCents || 0;
      if (row.netCents > 0 && available < row.netCents) {
        throw new HttpError(409, 'NET_ALREADY_WITHDRAWN', 'The carrier already withdrew this net.');
      }
      await refundSender(row);
      if (row.stripeTransferId) {
        await stripeClient().transfers.createReversal(
          row.stripeTransferId,
          {},
          { idempotencyKey: `reversal:${row.reservationId}:${row.cycle || 1}` }
        );
      }
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'NET_REVERSAL',
        bucket: 'available',
        cents: -row.netCents,
        walletInc: { availableToWithdrawCents: -row.netCents, totalGainCents: -row.netCents },
        statementInc: { gainCents: -row.netCents },
        period,
      });
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'COMMISSION_REVERSAL',
        bucket: 'platform',
        cents: -row.commissionCents,
        walletInc: { commissionCents: -row.commissionCents },
        statementInc: { commissionCents: -row.commissionCents, onlineCommissionCents: -row.commissionCents },
        period,
      });
    }
  }

  if (row.paymentMethod === 'CASH' && row.status === 'PENDING') {
    if (row.deliveredAt) {
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'CASH_DEBT_REVERSAL',
        bucket: 'cashDue',
        cents: -row.commissionCents,
        walletInc: { cashDueCents: -row.commissionCents, commissionCents: -row.commissionCents },
        statementInc: { commissionCents: -row.commissionCents, cashCommissionCents: -row.commissionCents },
        period,
      });
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'CASH_GAIN_REVERSAL',
        bucket: 'gain',
        cents: -row.netCents,
        walletInc: { totalGainCents: -row.netCents },
        statementInc: { gainCents: -row.netCents },
        period,
      });
    }
  }

  if (row.paymentMethod === 'CASH' && row.status === 'MONTHLY_INVOICED' && row.invoiceId) {
    const invoice = await CommissionInvoice.findById(row.invoiceId);
    if (invoice && invoice.status === 'OPEN') {
      invoice.bookingReservationIds = (invoice.bookingReservationIds || []).filter((id) => id !== row.reservationId);
      invoice.totalCents = Math.max(0, Number(invoice.totalCents || 0) - row.commissionCents);
      if (invoice.totalCents === 0) {
        invoice.status = 'PAID';
        invoice.paidAt = invoice.paidAt || new Date();
      }
      await invoice.save();
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'CASH_DEBT_REVERSAL',
        bucket: 'cashDue',
        cents: -row.commissionCents,
        walletInc: { cashDueCents: -row.commissionCents, commissionCents: -row.commissionCents },
        statementInc: { commissionCents: -row.commissionCents, cashCommissionCents: -row.commissionCents },
        period: invoice.period,
      });
    } else if (invoice && invoice.status === 'PAID') {
      await applyLedger({
        reservationId: row.reservationId,
        tripId: row.tripId,
        transporterId: row.transporterId,
        cycle: row.cycle,
        type: 'CARRIER_CREDIT',
        bucket: 'available',
        cents: row.commissionCents,
        walletInc: { availableToWithdrawCents: row.commissionCents },
        period: invoice.period,
      });
    }
  }

  row.status = 'VOID';
  await row.save();
  return { reservationId: row.reservationId, status: 'VOID' };
}

async function hold(transporterId) {
  const held = await carrierIsHeld(transporterId);
  return {
    held,
    code: held ? 'SUSPENDED_PAYMENT_DUE' : null,
    reason: held ? 'UNPAID_COMMISSION' : null,
    lateFees: false,
    reinstatesOnPayment: true,
    contestable: true,
  };
}

async function getPreferences(userId) {
  return preferenceView(userId);
}

async function putPreferences(userId, body) {
  const acceptCash = body?.acceptCash === true;
  const acceptOnline = body?.acceptOnline === true;
  if (typeof body?.acceptCash !== 'boolean' || typeof body?.acceptOnline !== 'boolean') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'acceptCash and acceptOnline must be booleans.');
  }
  if (!acceptCash && !acceptOnline) {
    throw new HttpError(400, 'PREFERENCE_REQUIRED', 'At least one payment method is required.');
  }
  const account = await ConnectedAccount.findOne({ userId: String(userId) }).lean();
  if (acceptOnline && !account?.chargesEnabled) {
    throw new HttpError(409, 'CONNECT_REQUIRED', 'Card payments need a connected account with charges enabled.');
  }
  await CarrierPaymentPreference.updateOne(
    { userId: String(userId) },
    { $set: { acceptCash, acceptOnline, userId: String(userId) } },
    { upsert: true }
  );
  return preferenceView(userId);
}

function connectReturnUrl() {
  return (process.env.CONNECT_RETURN_URL || 'http://localhost:8080/transporter/settings').trim();
}

function stripeAccountMissing(err) {
  const code = err?.code || err?.raw?.code;
  const message = String(err?.raw?.message || err?.message || '');
  return code === 'resource_missing' || /no such account/i.test(message);
}

async function createExpressAccount(stripe, userId, email) {
  return stripe.accounts.create({
    type: 'express',
    country: 'FR',
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    settings: {
      payouts: { schedule: { interval: 'manual' } },
    },
    metadata: { userId },
  });
}

async function keepPayoutsManual(stripe, accountId) {
  try {
    await stripe.accounts.update(accountId, {
      settings: { payouts: { schedule: { interval: 'manual' } } },
    });
  } catch (err) {
    console.error('[connect.payouts]', err?.message || err);
  }
}

const connectCreateTail = new Map();

function withConnectLock(userId, task) {
  const previous = connectCreateTail.get(userId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  connectCreateTail.set(
    userId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

async function onboardingLink(stripe, accountId) {
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: connectReturnUrl(),
    return_url: connectReturnUrl(),
    type: 'account_onboarding',
  });
  return link.url;
}

function connectView(row, { url = null, reused }) {
  const ready = Boolean(row.chargesEnabled && row.payoutsEnabled);
  return {
    url: ready ? null : url,
    reused,
    ready,
    stripeAccountId: row.stripeAccountId,
  };
}

async function rememberStripeAccount(row, account) {
  row.stripeAccountId = account.id;
  row.chargesEnabled = Boolean(account.charges_enabled);
  row.payoutsEnabled = Boolean(account.payouts_enabled);
  await row.save();
  return row;
}

async function connectAccountUnlocked(id, mail) {
  const stripe = stripeClient();
  let row = await ConnectedAccount.findOne({ userId: id });
  if (row?.stripeAccountId) {
    try {
      const account = await stripe.accounts.retrieve(row.stripeAccountId);
      await rememberStripeAccount(row, account);
      if (row.chargesEnabled && row.payoutsEnabled) return connectView(row, { reused: true });
      const url = await onboardingLink(stripe, row.stripeAccountId);
      return connectView(row, { url, reused: true });
    } catch (err) {
      if (!stripeAccountMissing(err)) throw err;
    }
  }
  const account = await createExpressAccount(stripe, id, mail);
  if (!row) {
    try {
      row = await ConnectedAccount.create({
        userId: id,
        stripeAccountId: account.id,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      row = await ConnectedAccount.findOne({ userId: id });
      if (!row?.stripeAccountId) throw err;
      const existing = await stripe.accounts.retrieve(row.stripeAccountId);
      await rememberStripeAccount(row, existing);
      if (row.chargesEnabled && row.payoutsEnabled) return connectView(row, { reused: true });
      const url = await onboardingLink(stripe, row.stripeAccountId);
      return connectView(row, { url, reused: true });
    }
  } else {
    await rememberStripeAccount(row, account);
  }
  const url = await onboardingLink(stripe, row.stripeAccountId);
  return connectView(row, { url, reused: false });
}

async function connectAccount(body) {
  const id = String(body?.userId || '').trim();
  const mail = String(body?.email || '').trim();
  if (!id || !mail) throw new HttpError(400, 'VALIDATION_ERROR', 'userId and email are required.');
  return withConnectLock(id, () => connectAccountUnlocked(id, mail));
}

async function connectStatus(userId) {
  const row = await ConnectedAccount.findOne({ userId: String(userId) });
  if (!row?.stripeAccountId) {
    return { stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false, limited: false, ready: false };
  }
  try {
    const account = await stripeClient().accounts.retrieve(row.stripeAccountId);
    row.chargesEnabled = Boolean(account.charges_enabled);
    row.payoutsEnabled = Boolean(account.payouts_enabled);
    await row.save();
  } catch (err) {
    if (stripeAccountMissing(err)) {
      row.chargesEnabled = false;
      row.payoutsEnabled = false;
      await row.save();
    } else {
      console.error('[connect.status]', err?.message || err);
    }
  }
  const ready = Boolean(row.chargesEnabled && row.payoutsEnabled);
  return {
    stripeAccountId: row.stripeAccountId,
    chargesEnabled: Boolean(row.chargesEnabled),
    payoutsEnabled: Boolean(row.payoutsEnabled),
    limited: !ready,
    ready,
  };
}

async function preview(body) {
  const amountCents = Number(body?.amountCents);
  const on = await feesEnabled();
  return quoteCommission(amountCents, on);
}

async function getSettings() {
  return { enablePlatformFees: await feesEnabled() };
}

async function putSettings(body) {
  if (typeof body?.enablePlatformFees !== 'boolean') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'enablePlatformFees must be a boolean.');
  }
  await PlatformFeeSetting.updateOne(
    { key: 'platform' },
    { $set: { enablePlatformFees: body.enablePlatformFees, key: 'platform' } },
    { upsert: true }
  );
  return { enablePlatformFees: body.enablePlatformFees };
}

function invoiceView(row) {
  return {
    id: String(row._id),
    transporterId: row.transporterId,
    period: row.period,
    totalCents: row.totalCents,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    status: row.status,
    paidAt: row.paidAt || null,
    bookingReservationIds: row.bookingReservationIds || [],
  };
}

async function listInvoices(query) {
  const filter = {};
  if (query?.transporterId) filter.transporterId = String(query.transporterId);
  if (query?.status) filter.status = String(query.status).toUpperCase();
  const rows = await CommissionInvoice.find(filter).sort({ issuedAt: -1 }).lean();
  return { invoices: rows.map(invoiceView) };
}

async function payInvoice(invoiceId) {
  const invoice = await CommissionInvoice.findById(invoiceId);
  if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found.');
  if (invoice.status !== 'PAID') {
    invoice.status = 'PAID';
    invoice.paidAt = new Date();
    await invoice.save();
    await BookingPayment.updateMany(
      { reservationId: { $in: invoice.bookingReservationIds || [] }, status: 'MONTHLY_INVOICED' },
      { $set: { status: 'PAID' } }
    );
  }
  return invoiceView(invoice);
}

async function commissionPot(transporterId, tripIds) {
  const ids = [...new Set(
    (Array.isArray(tripIds) ? tripIds : String(tripIds || '').split(','))
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )];
  if (!ids.length) {
    return { totalCents: 0, cashCents: 0, onlineCents: 0, currency: 'EUR', items: [] };
  }
  const rows = await BookingPayment.find({
    transporterId: String(transporterId),
    tripId: { $in: ids },
    status: { $nin: ['NONE', 'VOID'] },
    commissionCents: { $gt: 0 },
  })
    .select('reservationId tripId amountCents commissionCents paymentMethod status currency')
    .lean();
  let totalCents = 0;
  let cashCents = 0;
  let onlineCents = 0;
  const items = rows.map((row) => {
    const commissionCents = Number(row.commissionCents) || 0;
    totalCents += commissionCents;
    if (row.paymentMethod === 'ONLINE') onlineCents += commissionCents;
    else cashCents += commissionCents;
    return {
      reservationId: row.reservationId,
      tripId: row.tripId,
      amountCents: row.amountCents,
      commissionCents,
      paymentMethod: row.paymentMethod,
      status: row.status,
      currency: row.currency || 'EUR',
    };
  });
  return { totalCents, cashCents, onlineCents, currency: 'EUR', items };
}

async function wallet(transporterId) {
  const row = await CarrierWallet.findOne({ transporterId: String(transporterId) }).lean();
  return {
    totalGainCents: row?.totalGainCents || 0,
    commissionCents: row?.commissionCents || 0,
    availableToWithdrawCents: row?.availableToWithdrawCents || 0,
    cashDueCents: row?.cashDueCents || 0,
  };
}

async function savePayoutAccount(transporterId, body) {
  const iban = String(body?.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!iban) throw new HttpError(400, 'VALIDATION_ERROR', 'iban is required.');
  await CarrierPayoutAccount.updateOne(
    { transporterId: String(transporterId) },
    { $set: { iban, transporterId: String(transporterId) } },
    { upsert: true }
  );
  return { transporterId: String(transporterId), iban };
}

async function withdraw(transporterId, body) {
  const id = String(transporterId);
  const connected = await ConnectedAccount.findOne({ userId: id }).lean();
  if (!connected?.stripeAccountId || !connected.payoutsEnabled) {
    throw new HttpError(409, 'CONNECT_REQUIRED', 'Payouts are not enabled on the connected account.');
  }
  const current = await CarrierWallet.findOne({ transporterId: id }).lean();
  const available = current?.availableToWithdrawCents || 0;
  const requested = body?.amountCents == null ? available : Number(body.amountCents);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'amountCents must be a positive integer.');
  }
  if (requested > available) {
    throw new HttpError(409, 'INSUFFICIENT_BALANCE', 'Amount exceeds the available balance.');
  }
  const payout = await stripeClient().payouts.create(
    { amount: requested, currency: 'eur' },
    { stripeAccount: connected.stripeAccountId, idempotencyKey: `payout:${id}:${requested}:${Date.now()}` }
  );
  await applyLedger({
    reservationId: `withdraw:${payout.id}`,
    transporterId: id,
    cycle: 1,
    type: 'WITHDRAWAL',
    bucket: 'available',
    cents: -requested,
    walletInc: { availableToWithdrawCents: -requested },
  });
  return { payoutId: payout.id, amountCents: requested };
}

async function saveCommissionCard(transporterId, body) {
  const paymentMethodId = String(body?.paymentMethodId || '').trim();
  if (!paymentMethodId) throw new HttpError(400, 'VALIDATION_ERROR', 'paymentMethodId is required.');
  await CarrierCommissionCard.updateOne(
    { transporterId: String(transporterId) },
    { $set: { paymentMethodId, transporterId: String(transporterId) } },
    { upsert: true }
  );
  return { transporterId: String(transporterId), paymentMethodId };
}

async function payCashCommission(transporterId) {
  const id = String(transporterId);
  const card = await CarrierCommissionCard.findOne({ transporterId: id }).lean();
  if (!card?.paymentMethodId) {
    throw new HttpError(409, 'COMMISSION_CARD_REQUIRED', 'Add a card to pay Shippizy.');
  }
  const current = await wallet(id);
  if (current.cashDueCents <= 0) {
    return { chargedCents: 0, cashDueCents: 0 };
  }
  const open = await CommissionInvoice.find({ transporterId: id, status: 'OPEN' }).lean();
  const intent = await stripeClient().paymentIntents.create(
    {
      amount: current.cashDueCents,
      currency: 'eur',
      payment_method: card.paymentMethodId,
      confirm: true,
      off_session: true,
      metadata: { transporterId: id, purpose: 'cash_commission' },
    },
    { idempotencyKey: `cash-commission:${id}:${open.map((item) => String(item._id)).sort().join(',') || current.cashDueCents}` }
  );
  if (intent.status !== 'succeeded') {
    throw new HttpError(409, 'PAYMENT_ACTION_REQUIRED', 'The commission card payment was not completed.');
  }
  await applyLedger({
    reservationId: `cash-commission:${intent.id}`,
    transporterId: id,
    cycle: 1,
    type: 'CASH_COMMISSION_PAYMENT',
    bucket: 'cashDue',
    cents: -current.cashDueCents,
    walletInc: { cashDueCents: -current.cashDueCents },
  });
  const ids = open.map((item) => String(item._id));
  if (ids.length) {
    await CommissionInvoice.updateMany({ _id: { $in: ids } }, { $set: { status: 'PAID', paidAt: new Date() } });
    const reservationIds = open.flatMap((item) => item.bookingReservationIds || []);
    if (reservationIds.length) {
      await BookingPayment.updateMany(
        { reservationId: { $in: reservationIds }, status: 'MONTHLY_INVOICED' },
        { $set: { status: 'PAID' } }
      );
    }
  }
  return { chargedCents: current.cashDueCents, cashDueCents: 0 };
}

async function closeCashMonth(now = new Date(), options = {}) {
  const includeCurrent = options.includeCurrent === true;
  const current = parisParts(now).period;
  const rows = await BookingPayment.find({
    paymentMethod: 'CASH',
    status: 'PENDING',
    deliveredAt: { $ne: null },
  });
  const groups = new Map();
  for (const row of rows) {
    const rowPeriod = parisParts(row.deliveredAt).period;
    if (rowPeriod > current) continue;
    if (rowPeriod === current && !includeCurrent) continue;
    const key = `${row.transporterId}:${rowPeriod}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const issuedAt = now;
  const dueAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  for (const [, list] of groups) {
    const transporterId = list[0].transporterId;
    const period = parisParts(list[0].deliveredAt).period;
    const existing = await CommissionInvoice.findOne({ transporterId, period }).lean();
    if (existing) continue;
    const totalCents = list.reduce((sum, row) => sum + Number(row.commissionCents || 0), 0);
    const bookingReservationIds = list.map((row) => row.reservationId);
    const invoice = await CommissionInvoice.create({
      transporterId,
      period,
      totalCents,
      issuedAt,
      dueAt,
      status: totalCents === 0 ? 'PAID' : 'OPEN',
      paidAt: totalCents === 0 ? issuedAt : null,
      bookingReservationIds,
    });
    await BookingPayment.updateMany(
      { reservationId: { $in: bookingReservationIds }, status: 'PENDING' },
      { $set: { status: 'MONTHLY_INVOICED', invoiceId: String(invoice._id) } }
    );
    await CarrierMonthStatement.updateOne(
      { transporterId, period },
      { $set: { invoiceId: String(invoice._id) }, $setOnInsert: { transporterId, period } },
      { upsert: true }
    );
  }
  return { period: current, transporters: groups.size };
}

function startCashMonthJob() {
  const tick = async () => {
    try {
      await closeCashMonth(new Date(), { includeCurrent: isLastParisDay() });
    } catch (err) {
      console.error('[booking] cash month job failed:', err?.message || err);
    }
  };
  setInterval(tick, 60 * 60 * 1000);
  tick();
}

async function handleStripeEvent(event) {
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const reservationId = pi?.metadata?.reservationId;
    if (!reservationId) return;
    const row = await BookingPayment.findOne({
      reservationId: String(reservationId),
      stripePaymentIntentId: pi.id,
    });
    if (!row) return;
    if (row.status === 'PAID' || row.status === 'VOID') return;
    if (row.status === 'UNPAID') {
      row.status = 'HELD';
      await row.save();
    }
    if (row.status === 'HELD') await settlePlatformCharge(row);
    return;
  }
  if (event.type === 'payment_intent.payment_failed') return;
  if (event.type === 'account.updated') {
    const account = event.data.object;
    if (!account?.id) return;
    await ConnectedAccount.updateOne(
      { stripeAccountId: account.id },
      {
        $set: {
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
        },
      }
    );
  }
}

module.exports = {
  HttpError,
  quoteCommission,
  opened,
  confirm,
  pay,
  getBooking,
  adminReservationPayment,
  adminTripPayments,
  requirePaid,
  delivered,
  voidBooking,
  hold,
  getPreferences,
  putPreferences,
  connectAccount,
  connectStatus,
  preview,
  getSettings,
  putSettings,
  listInvoices,
  payInvoice,
  commissionPot,
  wallet,
  savePayoutAccount,
  withdraw,
  saveCommissionCard,
  payCashCommission,
  closeCashMonth,
  startCashMonthJob,
  handleStripeEvent,
};
