const axios = require('axios');

function resolveNotifyUrl() {
  const explicit = (process.env.SHIPPIZY_SUBSCRIPTION_INVOICE_NOTIFY_URL || '').trim();
  if (explicit) return explicit;
  const sync = (process.env.SPRING_SYNC_URL || '').trim();
  if (!sync) return '';
  return sync.replace(/\/stripe-sync\/?$/, '/subscription-invoice-notify');
}

/**
 * Ask shippizy-back to send subscription transactional emails (Brevo).
 * Stripe webhooks are handled here; email templates live on the main API.
 */
async function notifyMainApiSubscriptionInvoice({ invoiceId, outcome }) {
  const url = resolveNotifyUrl();
  const invId = String(invoiceId || '').trim();
  const kind = String(outcome || 'paid').trim().toLowerCase();
  if (!url || !invId) return;
  if (kind !== 'paid' && kind !== 'failed') return;

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SPRING_SYNC_API_KEY) {
    headers['X-Internal-Api-Key'] = process.env.SPRING_SYNC_API_KEY;
  }

  try {
    await axios.post(url, { invoiceId: invId, outcome: kind }, { headers, timeout: 20000 });
  } catch (err) {
    console.error('[billing-service] subscription invoice notify failed:', err?.message || err, {
      responseStatus: err?.response?.status,
      responseData: err?.response?.data,
      invoiceId: invId,
      outcome: kind,
    });
  }
}

module.exports = { notifyMainApiSubscriptionInvoice };
