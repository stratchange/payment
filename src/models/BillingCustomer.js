const mongoose = require('mongoose');

const billingCustomerSchema = new mongoose.Schema(
  {
    /** Shippizy user id (Mongo ObjectId string or legacy id). */
    userId: { type: String, required: true, unique: true, index: true, trim: true },
    stripeCustomerId: { type: String, required: true, trim: true, index: true },
    email: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.BillingCustomer || mongoose.model('BillingCustomer', billingCustomerSchema);
