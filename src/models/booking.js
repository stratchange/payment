const mongoose = require('mongoose');

const bookingPaymentSchema = new mongoose.Schema(
  {
    reservationId: { type: String, required: true, unique: true, trim: true },
    tripId: { type: String, default: null, trim: true },
    transporterId: { type: String, required: true, trim: true, index: true },
    expeditorId: { type: String, default: null, trim: true },
    amountCents: { type: Number, required: true },
    commissionCents: { type: Number, required: true },
    netCents: { type: Number, required: true },
    currency: { type: String, default: 'EUR', trim: true },
    paymentMethod: { type: String, enum: ['CASH', 'ONLINE'], required: true },
    status: {
      type: String,
      enum: ['NONE', 'UNPAID', 'HELD', 'PENDING', 'PAID', 'MONTHLY_INVOICED', 'VOID'],
      required: true,
    },
    cycle: { type: Number, default: 1 },
    stripePaymentIntentId: { type: String, default: null },
    stripeTransferId: { type: String, default: null },
    stripeRefundId: { type: String, default: null },
    invoiceId: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'booking_payments' }
);

const ledgerEntrySchema = new mongoose.Schema(
  {
    reservationId: { type: String, required: true, trim: true },
    tripId: { type: String, default: null, trim: true },
    transporterId: { type: String, required: true, trim: true, index: true },
    cycle: { type: Number, required: true },
    type: { type: String, required: true, trim: true },
    bucket: { type: String, enum: ['available', 'cashDue', 'gain', 'platform'], required: true },
    cents: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ledger_entries' }
);
ledgerEntrySchema.index({ reservationId: 1, type: 1, cycle: 1 }, { unique: true });

const carrierWalletSchema = new mongoose.Schema(
  {
    transporterId: { type: String, required: true, unique: true, trim: true },
    totalGainCents: { type: Number, default: 0 },
    commissionCents: { type: Number, default: 0 },
    availableToWithdrawCents: { type: Number, default: 0 },
    cashDueCents: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'carrier_wallets' }
);

const carrierMonthStatementSchema = new mongoose.Schema(
  {
    transporterId: { type: String, required: true, trim: true },
    period: { type: String, required: true, trim: true },
    gainCents: { type: Number, default: 0 },
    commissionCents: { type: Number, default: 0 },
    cashCommissionCents: { type: Number, default: 0 },
    onlineCommissionCents: { type: Number, default: 0 },
    invoiceId: { type: String, default: null },
  },
  { timestamps: true, collection: 'carrier_month_statements' }
);
carrierMonthStatementSchema.index({ transporterId: 1, period: 1 }, { unique: true });

const commissionInvoiceSchema = new mongoose.Schema(
  {
    transporterId: { type: String, required: true, trim: true, index: true },
    period: { type: String, required: true, trim: true },
    totalCents: { type: Number, required: true },
    issuedAt: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'PAID'], required: true },
    paidAt: { type: Date, default: null },
    bookingReservationIds: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'commission_invoices' }
);
commissionInvoiceSchema.index({ transporterId: 1, period: 1 }, { unique: true });

const connectedAccountSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, trim: true },
    stripeAccountId: { type: String, required: true, trim: true },
    chargesEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'connected_accounts' }
);

const carrierPaymentPreferenceSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, trim: true },
    acceptCash: { type: Boolean, default: true },
    acceptOnline: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'carrier_payment_preferences' }
);

const platformFeeSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'platform' },
    enablePlatformFees: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'platform_fee_settings' }
);

const carrierPayoutAccountSchema = new mongoose.Schema(
  {
    transporterId: { type: String, required: true, unique: true, trim: true },
    iban: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: 'carrier_payout_accounts' }
);

const carrierCommissionCardSchema = new mongoose.Schema(
  {
    transporterId: { type: String, required: true, unique: true, trim: true },
    paymentMethodId: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: 'carrier_commission_cards' }
);

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  BookingPayment: model('BookingPayment', bookingPaymentSchema),
  LedgerEntry: model('LedgerEntry', ledgerEntrySchema),
  CarrierWallet: model('CarrierWallet', carrierWalletSchema),
  CarrierMonthStatement: model('CarrierMonthStatement', carrierMonthStatementSchema),
  CommissionInvoice: model('CommissionInvoice', commissionInvoiceSchema),
  ConnectedAccount: model('ConnectedAccount', connectedAccountSchema),
  CarrierPaymentPreference: model('CarrierPaymentPreference', carrierPaymentPreferenceSchema),
  PlatformFeeSetting: model('PlatformFeeSetting', platformFeeSettingSchema),
  CarrierPayoutAccount: model('CarrierPayoutAccount', carrierPayoutAccountSchema),
  CarrierCommissionCard: model('CarrierCommissionCard', carrierCommissionCardSchema),
};
