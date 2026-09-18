# Transaction server — security model

This server holds the platform's Stripe secret key and is the only writer of
money tables. Everything below exists because of that.

## Trust boundaries

```
buyer / seller / admin browser
        │  user JWT
        ▼
  TradeAuct_backend_server (public, port 9000)
        │  service JWT + HMAC signature + forwarded user token
        ▼
  Tradeauct-transaction-server (private, port 9100)
        │  secret key
        ▼
      Stripe
```

Only one route on this server is reachable from the internet:
`POST /webhooks/stripe`. Everything under `/internal` must be unreachable from
outside the private network — the application checks the caller address, but
that check is the second line of defence, not the first.

## Inbound authentication (`/internal/*`)

Four checks, all required. See `src/core/security/serviceAuth.ts`.

1. **Service identity** — `Authorization: Bearer <ES256 JWT>`, `iss=main-server`,
   `aud=txn-server`, 60 s TTL, unique `jti`. The main server signs with its
   private key; this server holds only the public key, so compromising this
   server does not yield the ability to impersonate the main one.
2. **Request binding** — `X-TA-Signature` is
   `HMAC-SHA256(secret, method \n path \n timestamp \n nonce \n sha256(body))`,
   base64. The path includes the query string. Comparison is constant-time.
3. **Freshness and replay** — `X-TA-Timestamp` must be within
   `SERVICE_SIGNATURE_MAX_SKEW_SECONDS` (default 120 s); the nonce and the JWT
   `jti` are each redeemable once, recorded in Redis for
   `SERVICE_REPLAY_WINDOW_SECONDS` (default 300 s). If Redis cannot answer, the
   request is **rejected** — an unverifiable replay check is not a passed one.
4. **Caller address** — `INTERNAL_IP_ALLOWLIST`, when set.

### Acting on behalf of a user

Service identity answers *which service is calling*. It does not answer *whose
money this is*. Buyer-scoped routes additionally require `X-TA-Actor`: the end
user's own access token, which this server verifies itself against
`JWT_SECRET`. A buyer id in a request body is never trusted, so a compromised
main server cannot charge or read an arbitrary account.

Admin routes resolve the admin's permissions from the database per request
(`requireAdminActor`), not from claims in the token.

## Idempotency

Every mutating internal endpoint requires an `Idempotency-Key`
(`src/core/idempotency.ts`):

- same key + same body → the stored response is replayed, no second charge;
- same key + different body → `409 IDEMPOTENCY_KEY_REUSED`;
- key claimed but not finished → `409 IDEMPOTENCY_IN_PROGRESS`;
- a failed request releases its key, so a decline stays retryable.

Stripe idempotency keys include the attempt number, so a genuine second attempt
is a genuinely new charge rather than Stripe's cached answer to the first.

## Stripe webhooks

- Signature verification is mandatory and verified against the raw bytes.
  There is no "secret not configured" path: `STRIPE_WEBHOOK_SECRET` is required
  at startup.
- The `stripe_event_logs.eventId` unique insert is taken as a lock **before**
  processing, so a redelivery cannot be processed twice.
- Processing failures return 5xx so Stripe retries. A handler that throws must
  never be answered with 200.

## Money

- Amounts are integers in the currency's minor unit (`src/core/money.ts`).
  `Math.round(x * 100)` is wrong for JPY (0 decimals) and KWD (3).
- Prices are derived from the listing or auction. No request body carries an
  amount, and schemas are `.strict()` so a reintroduced price field is rejected
  rather than ignored.
- Before an order is treated as paid, `amount_received` is reconciled against
  the quote. A mismatch quarantines the payment and alerts; it never fulfils.
- The ledger is append-only. Corrections are compensating transactions, and
  `prisma/grants/roles.sql` revokes UPDATE/DELETE on the ledger tables from
  every application role.

## Secrets

| Secret | Held by | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | transaction server only | Must not exist in the main server or any frontend environment |
| `STRIPE_WEBHOOK_SECRET` | transaction server only | Per endpoint; the Stripe CLI secret differs from the dashboard one |
| `SERVICE_HMAC_SECRET` | both servers | Shared; signs request bodies in both directions |
| `SERVICE_JWT_PRIVATE_KEY_*` | its own service only | Never copied to the peer |
| `JWT_SECRET` | both servers | Verifies end-user tokens |

`npm run keys:generate` prints a matched set for both servers. Nothing is
written to disk.

### Rotating the service keys

1. Generate a new key id and HMAC secret.
2. On the transaction server, set `SERVICE_KEY_ID_PREVIOUS` /
   `SERVICE_HMAC_SECRET_PREVIOUS` to the current values, and
   `SERVICE_KEY_ID` / `SERVICE_HMAC_SECRET` to the new ones. Deploy. Both keys
   are now accepted.
3. Deploy the main server with the new key id and secret.
4. Remove the `*_PREVIOUS` values from the transaction server and deploy.

Rotate the ES256 keypairs the same way, one direction at a time.

## Logging

`src/core/logger.ts` emits JSON, carries a trace id across both services via
`X-TA-Trace-Id`, and redacts by key name: anything matching
secret/password/token/authorization/signature/card is dropped, and
email/phone/address values are fingerprinted rather than printed. Log ids, not
identities. Never log card metadata.

## What to check in review

- Does any new route write money without an `Idempotency-Key`?
- Does any new endpoint accept an amount, a buyer id or a seller id from the
  request instead of deriving it?
- Does any handler answer a Stripe webhook 200 on a path that did not finish?
- Does any new money table exist outside `prisma/grants/roles.sql`?
- Does any log line carry a raw email, a token or a full address?
