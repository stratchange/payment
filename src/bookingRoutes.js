const express = require('express');
const bodyParser = require('body-parser');
const booking = require('./bookingService');

const router = express.Router();
const json = bodyParser.json();

function requireInternalKey(req) {
  const expected = process.env.SPRING_SYNC_API_KEY;
  if (!expected) return true;
  return req.headers['x-internal-api-key'] === expected;
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      if (!requireInternalKey(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
      const data = await fn(req);
      if (data === undefined) return undefined;
      return res.json(data);
    } catch (err) {
      if (err instanceof booking.HttpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[booking]', err);
      return res.status(500).json({ error: err.message || 'Internal error', code: 'BILLING_ERROR' });
    }
  };
}

router.post('/reservations/:reservationId/opened', json, handle((req) => booking.opened(req.params.reservationId)));
router.post('/reservations/:reservationId/confirm', json, handle((req) => booking.confirm(req.params.reservationId)));
router.post('/reservations/:reservationId/pay', json, handle((req) => booking.pay(req.params.reservationId)));
router.get('/reservations/:reservationId', handle((req) => booking.getBooking(req.params.reservationId)));
router.get('/admin/reservations/:reservationId/payment', handle((req) => booking.adminReservationPayment(req.params.reservationId)));
router.get('/admin/trips/:tripId/payments', handle((req) => booking.adminTripPayments(req.params.tripId)));
router.post('/reservations/:reservationId/require-paid', json, handle((req) => booking.requirePaid(req.params.reservationId)));
router.post('/reservations/:reservationId/delivered', json, handle((req) => booking.delivered(req.params.reservationId)));
router.post('/reservations/:reservationId/void', json, handle((req) => booking.voidBooking(req.params.reservationId)));

router.get('/carriers/:transporterId/hold', handle((req) => booking.hold(req.params.transporterId)));
router.get('/carriers/:userId/payment-preferences', handle((req) => booking.getPreferences(req.params.userId)));
router.put('/carriers/:userId/payment-preferences', json, handle((req) => booking.putPreferences(req.params.userId, req.body || {})));
router.get('/carriers/:transporterId/commission-pot', handle((req) => booking.commissionPot(req.params.transporterId, req.query.tripIds)));
router.get('/carriers/:transporterId/wallet', handle((req) => booking.wallet(req.params.transporterId)));
router.post('/carriers/:transporterId/payout-account', json, handle((req) => booking.savePayoutAccount(req.params.transporterId, req.body || {})));
router.post('/carriers/:transporterId/withdraw', json, handle((req) => booking.withdraw(req.params.transporterId, req.body || {})));
router.post('/carriers/:transporterId/commission-card', json, handle((req) => booking.saveCommissionCard(req.params.transporterId, req.body || {})));
router.post('/carriers/:transporterId/pay-cash-commission', json, handle((req) => booking.payCashCommission(req.params.transporterId)));

router.post('/connect/account', json, handle((req) => booking.connectAccount(req.body || {})));
router.get('/connect/account/:userId', handle((req) => booking.connectStatus(req.params.userId)));

router.post('/commissions/preview', json, handle((req) => booking.preview(req.body || {})));
router.get('/settings', handle(() => booking.getSettings()));
router.put('/settings', json, handle((req) => booking.putSettings(req.body || {})));

router.get('/invoices', handle((req) => booking.listInvoices(req.query || {})));
router.post('/invoices/:invoiceId/pay', json, handle((req) => booking.payInvoice(req.params.invoiceId)));

module.exports = router;
