-- Agency-level money: what comes IN, what goes OUT, and whose pocket it came from.
--
-- Everything in this system up to now tracks money owed to CLIPPERS and nothing
-- else. payments.clipper_id is NOT NULL with no counterparty type, so there is
-- no row shape that can represent money coming in, or money going anywhere
-- other than a clipper. There is no expenses table, no invoice table, no
-- cash-position concept and no way to tell an internal ClipGrow campaign from a
-- client one -- so nobody could answer "have we been paid", "what did we spend
-- and why", "are we cash positive", or "what does the agency owe me personally".
--
-- Note the two are different questions and this schema keeps them apart:
--   PROFIT    = management fees earned - operating costs. The client's 100%
--               passes through to clippers and is not our cost.
--   CASH FLOW = when money actually moved. The founder pays clippers before the
--               client pays him, so a profitable month can still leave the
--               account empty. Collapsing these into one number is the mistake
--               this table exists to prevent.

-- Where money physically sits. Today "Agency" and "Dhruv" are the same bank
-- account; the split is what makes "what the agency owes me" computable at all.
CREATE TABLE IF NOT EXISTS wallets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  -- Two distinct pots, and the difference between them is the whole point:
  --
  --   agency    The working account. The clipper share of every client payment
  --             lands here, and clipper payouts and running costs leave from
  --             here. If it is empty, clippers cannot be paid -- that is the
  --             whole point of separating it.
  --   clipgrow  ClipGrow's own earned money: the management-fee share of each
  --             client payment. Kept apart so fee income can never be mistaken
  --             for money that is really owed to clippers.
  --
  -- Deliberately only two. A founder paying a cost personally is recorded as a
  -- capital_in CATEGORY against the agency wallet rather than a third wallet --
  -- what the agency owes them is then a sum over the ledger, with one less pot
  -- to keep reconciled.
  kind       TEXT NOT NULL DEFAULT 'agency',
  owner      TEXT,
  -- Unused for now; kept so a future per-client wallet stays possible.
  client_id  INTEGER,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_name ON wallets(name);

-- Every rupee in or out, with a wallet, a category, a reason and a date.
--
-- Deliberately no NOT NULL foreign key except wallet_id. ig_api_calls carries a
-- NOT NULL key onto social_accounts and that is exactly what made disconnecting
-- any synced account fail with a bare "internal server error". A ledger must
-- never be able to block a delete elsewhere.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'in' | 'out'. amount is always POSITIVE; direction carries the sign, so a
  -- sum can never be quietly wrong because someone typed a minus.
  direction          TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  wallet_id          INTEGER NOT NULL REFERENCES wallets(id),
  -- Set when this entry moves money BETWEEN wallets (e.g. the agency repaying
  -- the founder). One row, both balances affected.
  transfer_wallet_id INTEGER REFERENCES wallets(id),
  -- client_payment | clipper_payout | management_fee | tool | ads | refund
  -- | capital_in | capital_repayment | other
  category           TEXT NOT NULL,
  -- Soft links, deliberately WITHOUT foreign keys. A hard key here would make
  -- the ledger able to refuse a delete elsewhere: reversing a payment deletes
  -- its payments row, and a FK on payment_id blocks that outright -- the exact
  -- shape of the ig_api_calls bug that made disconnecting a synced account
  -- fail. An append-only record must never hold the rest of the system hostage.
  campaign_id        INTEGER,
  client_id          INTEGER,
  clipper_id         INTEGER,
  invoice_id         INTEGER,
  -- Links an entry to the clipper payout it mirrors, so a settlement appears
  -- once in payments and once here without being counted twice.
  payment_id         INTEGER,
  method             TEXT,
  reference          TEXT,
  -- The "why we spend" the founder asked for. Free text, deliberately.
  note               TEXT,
  -- Voided rather than deleted: a ledger you can silently erase is not a ledger.
  status             TEXT NOT NULL DEFAULT 'active',
  occurred_at        INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  -- There are no staff accounts yet (Phase 4), so this is free text for now --
  -- present from day one so attribution is not lost before then.
  created_by         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet    ON ledger_entries(wallet_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_category  ON ledger_entries(category, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_campaign  ON ledger_entries(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ledger_client    ON ledger_entries(client_id);
CREATE INDEX IF NOT EXISTS idx_ledger_payment   ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_occurred  ON ledger_entries(occurred_at);

-- What a client has been billed, per campaign, per tranche. Receivables become
-- a real number rather than something remembered from a WhatsApp thread.
CREATE TABLE IF NOT EXISTS client_invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  -- first_40 | final_60 | settlement | adhoc
  tranche     TEXT NOT NULL DEFAULT 'adhoc',
  amount      INTEGER NOT NULL,
  -- due | part_paid | paid | void
  status      TEXT NOT NULL DEFAULT 'due',
  issued_at   INTEGER NOT NULL,
  due_at      INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_client   ON client_invoices(client_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_campaign ON client_invoices(campaign_id);

-- A campaign becomes billable to ONE client. client_campaigns stays viewing
-- access only: it allows the same campaign to be granted to several clients, so
-- it can never say who pays for it.
ALTER TABLE campaigns ADD COLUMN client_id INTEGER REFERENCES clients(id);
-- client | internal. An internal campaign is ClipGrow marketing its own
-- product: no client funds it, so its clipper payouts are a real COST rather
-- than pass-through, and it earns no management fee.
ALTER TABLE campaigns ADD COLUMN campaign_kind TEXT NOT NULL DEFAULT 'client';
-- The management fee as a percentage of budget consumed. 20 today; per-campaign
-- so a legacy or discounted deal can be recorded honestly rather than fudged.
ALTER TABLE campaigns ADD COLUMN fee_percent REAL NOT NULL DEFAULT 20;
-- The five-day termination notice.
ALTER TABLE campaigns ADD COLUMN notice_at INTEGER;
ALTER TABLE campaigns ADD COLUMN notice_ends_at INTEGER;
ALTER TABLE campaigns ADD COLUMN closed_at INTEGER;

-- The two pots. One bank account today; the split is what stops anyone
-- mistaking money that is really owed to clippers for money the agency has
-- actually earned.
INSERT INTO wallets (name, kind, owner, status, created_at)
SELECT 'Agency wallet', 'agency', NULL, 'active', CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE kind = 'agency');

INSERT INTO wallets (name, kind, owner, status, created_at)
SELECT 'ClipGrow wallet', 'clipgrow', NULL, 'active', CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE kind = 'clipgrow');

-- Backfill: every clipper payout so far came out of the founder's own pocket,
-- which is what actually happened -- payouts are arranged over WhatsApp and paid
-- personally. This means the ledger is not empty on day one and the founder's
-- outstanding balance starts from the truth. Entries stay editable, so any that
-- were really agency money can be re-attributed afterwards.
INSERT INTO ledger_entries
  (direction, amount, wallet_id, category, campaign_id, clipper_id, payment_id,
   method, reference, note, status, occurred_at, created_at, created_by)
SELECT 'out', p.amount,
       (SELECT id FROM wallets WHERE kind = 'agency'),
       'clipper_payout', p.campaign_id, p.clipper_id, p.id,
       p.method, p.reference,
       'Backfilled from the payments ledger (' || p.kind || ')',
       'active', COALESCE(p.paid_at, p.created_at), p.created_at, 'backfill'
FROM payments p
WHERE NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.payment_id = p.id);
