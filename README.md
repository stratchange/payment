# Stripe Service (billing-service) — Shippizy

## Overview
This microservice is responsible for all Stripe operations in Shippizy:

- Create Stripe Checkout Sessions for subscriptions (hosted redirect flow)
- Create **Embedded Checkout** sessions (so the payment UI is rendered inside your app)
- Expose a **Stripe webhook** to receive subscription events
- Sync subscription status to the Shippizy backend (`shippizy-back-V1`) via an internal HTTP endpoint

Base URL (default):
- `http://localhost:3001`

All billing endpoints are mounted under:
- `/billing`

---

## How to run

```bash
cd stripe
npm install
npm run dev
```

The service listens on `PORT` (default `3001`).

Health check:
- `GET /health`

---

## Local webhook setup (required in dev)

In local development, your backend subscription update depends on Stripe webhooks being delivered to this service.

Use the Stripe CLI to forward webhooks to your local server:

```bash
stripe listen --forward-to http://localhost:3001/billing/webhook
```

Then perform a payment and verify:
- Stripe service logs: `Received webhook event: ...`
- Backend logs: the `/api/v1/internal/billing/stripe-sync` endpoint is called successfully

---

## Endpoints

### `GET /health`
Returns `{ status: 'ok' }` to confirm the service is running.

### `POST /billing/checkout-session` (hosted redirect flow)
**Purpose**
Create a Stripe Checkout Session in `mode=subscription` and return a hosted `url`.

**Request body**
```json
{ "userId": "123", "email": "t@x.com", "plan": "MONTHLY|YEARLY" }
```

**Response**
```json
{ "url": "https://checkout.stripe.com/..." }
```

---

### `POST /billing/embedded-checkout-session` (embedded checkout)
**Purpose**
Create a Stripe Checkout Session configured with `ui_mode: embedded` and return a `clientSecret` so the frontend can render embedded checkout.

**Request body**
```json
{ "userId": "123", "email": "t@x.com", "plan": "MONTHLY|YEARLY" }
```

**Response**
```json
{ "clientSecret": "cs_test_..." }
```

**Important**
In embedded mode, Stripe requires a `return_url` (not `success_url`/`cancel_url`).

---

### `POST /billing/portal`
**Purpose**
Create a Stripe Billing Portal session URL.

**Request body**
```json
{ "customerId": "cus_..." }
```

**Response**
```json
{ "url": "https://billing.stripe.com/..." }
```

---

### `POST /billing/webhook` (Stripe webhook)
**Purpose**
Receive Stripe webhook events and sync subscription status into your backend.

**Signature verification**
Uses `STRIPE_WEBHOOK_SECRET` and raw body:
- `bodyParser.raw({ type: 'application/json' })`
- `stripeLib.webhooks.constructEvent(...)`

**Handled events**
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

On relevant events, it:
1. Retrieves the Stripe subscription (when applicable)
2. Calls `syncSubscriptionToSpring(...)`

**Response**
Always returns:
```json
{ "received": true }
```

---

### `GET /billing/embedded-checkout-session-status?session_id=...`
**Purpose**
Frontend can poll embedded checkout session status after returning to the app.

**Query**
- `session_id` (example: `cs_test_...`)

**Response**
```json
{
  "status": "complete",
  "paymentStatus": "paid",
  "customerId": "cus_...",
  "subscriptionId": "sub_..."
}
```

---

## Internal logic (`src/stripeService.js`)

### Price and plan mapping
- `resolvePriceId(plan)`
  - `MONTHLY`  -> `STRIPE_PRICE_ID_MONTHLY`
  - `YEARLY`   -> `STRIPE_PRICE_ID_YEARLY`

- `mapPlanByPriceId(priceId)`
  - price ID monthly -> `MONTHLY`
  - price ID yearly  -> `YEARLY`

### Status mapping
- `mapStatus(stripeStatus)`
Converts Stripe subscription states to simplified values such as:
- `active` -> `ACTIVE`
- `trialing` -> `TRIALING`
- `past_due` -> `PAST_DUE`
- `canceled` -> `CANCELED`
- etc.

### Date conversion
- `toIsoFromEpochSeconds(epochSeconds)`
Converts `subscription.current_period_end` into an ISO string.

---

## Syncing subscription state to backend

### `syncSubscriptionToSpring(subscription, userIdOverride)`
**Purpose**
Send subscription state to your Shippizy backend so it can update the user subscription in MongoDB.

**Determine `userId`**
- First uses `userIdOverride`
- Else falls back to `subscription.metadata.userId`

**Build payload**
- `userId`
- `plan` (derived from Stripe price id)
- `status` (mapped Stripe subscription status)
- `currentPeriodEnd` (ISO)
- `cancelAtPeriodEnd`
- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripePriceId`

**Backend call**
- `POST ${SPRING_SYNC_URL}`
- If `SPRING_SYNC_API_KEY` is set, sends header:
  - `X-Internal-Api-Key: ${SPRING_SYNC_API_KEY}`

If the backend sync fails, the service logs detailed info:
- message
- response status
- response data
- payload

---

## Environment variables (`stripe/.env`)

**Do not commit secrets.**

Stripe credentials:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Plan price IDs:
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`

Embedded checkout return URL:
- `STRIPE_RETURN_URL`
  - Used as `return_url` when creating embedded checkout sessions
  - Example:
    - `http://localhost:8080/payment-return?session_id={CHECKOUT_SESSION_ID}`

Hosted checkout fallback (optional):
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`

Billing portal return:
- `STRIPE_PORTAL_RETURN_URL`

Backend sync target:
- `SPRING_SYNC_URL`
  - Example:
    - `http://localhost:5000/api/v1/internal/billing/stripe-sync`
- `SPRING_SYNC_API_KEY` (optional)

---

## Debug checklist (when subscription does not save)
1) Frontend
   - `POST /billing/embedded-checkout-session` must return a valid `clientSecret`
2) Stripe webhook
   - Ensure `POST /billing/webhook` is received by this service and signature verification passes
3) Backend sync
   - `SPRING_SYNC_URL` must exist and be reachable from the Stripe service
   - If sync fails, logs include `payload` and the backend response
