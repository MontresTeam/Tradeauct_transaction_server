-- ===========================================================================
--  TradeAuct database roles
--
--  Both servers share one database and one schema, so "who owns this table"
--  cannot be a convention — it has to be a grant. This file is the boundary:
--
--    tradeauct_app  (main server)        reads everything, writes everything
--                                        except the money tables
--    tradeauct_txn  (transaction server) reads everything, writes only the
--                                        money tables
--
--  Apply AFTER every `prisma db push` / `prisma migrate deploy`, because
--  Prisma creates new tables owned by the migrating role with no grants for
--  anyone else.
--
--  Run as the database owner:
--      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/grants/roles.sql
--
--  Rollout note: apply this only at the end of the payment migration
--  (phase 7). Applying it earlier will break the main server's payment module
--  while that module still writes these tables, which is exactly what it is
--  designed to prevent.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Roles. Passwords are set out of band; these statements only ensure the roles
-- exist and can log in.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradeauct_app') THEN
    CREATE ROLE tradeauct_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradeauct_txn') THEN
    CREATE ROLE tradeauct_txn LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tradeauct_app, tradeauct_txn', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO tradeauct_app, tradeauct_txn;

-- ---------------------------------------------------------------------------
-- Baseline: both roles can read everything and use every sequence.
-- Reads stay open on purpose — the transaction server needs Listing, Auction,
-- Buyer and Seller to price an order, and the main server needs payment status
-- to render an order page.
-- ---------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tradeauct_app, tradeauct_txn;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tradeauct_app, tradeauct_txn;

-- Default privileges so tables created by a later migration inherit the same
-- read access without anyone remembering to re-run this section.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO tradeauct_app, tradeauct_txn;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tradeauct_app, tradeauct_txn;

-- ---------------------------------------------------------------------------
-- Write access: main server gets everything, then the money tables are taken
-- back. Granting broadly and revoking narrowly means a table added by a future
-- migration is writable by the main server by default, which is the safe
-- direction — a new money table has to be added to the list below explicitly.
-- ---------------------------------------------------------------------------
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tradeauct_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE ON TABLES TO tradeauct_app;

-- The money tables. Keep this list in step with
-- prisma/schema/transactionServer.prisma and the payment models in
-- prisma/schema/transaction.prisma.
DO $$
DECLARE
  money_table text;
  money_tables text[] := ARRAY[
    -- existing payment domain
    'Payment',
    'SavedPaymentMethod',
    'stripe_event_logs',
    'SellerSettlement',
    'SettlementAdjustment',
    'SellerWallet',
    'WalletTransaction',
    'SellerPayout',
    'FinancialAuditLog',
    -- owned by the transaction server
    'payment_attempts',
    'ledger_transactions',
    'ledger_entries',
    'refunds',
    'stripe_disputes',
    'connect_accounts',
    'payout_transfers',
    'outbox_events',
    'idempotency_keys',
    'service_audit_logs'
  ];
BEGIN
  FOREACH money_table IN ARRAY money_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = money_table
    ) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM tradeauct_app', money_table);
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO tradeauct_txn', money_table);
    ELSE
      RAISE WARNING 'Money table % does not exist yet; skipped', money_table;
    END IF;
  END LOOP;
END
$$;

-- `processed_events` is the main server's inbound dedup table: the consumer
-- writes it, so it belongs to the main server rather than the transaction one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'processed_events'
  ) THEN
    GRANT INSERT, UPDATE, DELETE ON public.processed_events TO tradeauct_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The ledger is append-only. Even the role that owns it may not rewrite
-- history: a correction is a new compensating transaction, never an UPDATE.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ledger_entries'
  ) THEN
    REVOKE UPDATE, DELETE ON public.ledger_entries FROM tradeauct_txn, tradeauct_app;
    REVOKE UPDATE, DELETE ON public.ledger_transactions FROM tradeauct_txn, tradeauct_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Verification. Both queries should return zero rows.
-- ---------------------------------------------------------------------------
-- Main server must not be able to write any money table:
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'tradeauct_app'
--      AND privilege_type IN ('INSERT','UPDATE','DELETE')
--      AND table_name IN ('Payment','ledger_entries','refunds','payout_transfers');
--
-- Transaction server must not be able to write listings or auctions:
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'tradeauct_txn'
--      AND privilege_type IN ('INSERT','UPDATE','DELETE')
--      AND table_name IN ('Listing','auctions','auction_bids','FulfillmentOrder');
