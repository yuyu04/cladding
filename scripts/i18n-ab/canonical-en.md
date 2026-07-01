# Project Context — PayBridge (B2B Payment Settlement SaaS)

## 1. Why does this project exist?

Mid-market B2B merchants reconcile payments across several providers by hand:
they export spreadsheets from Stripe and Toss, match them against their own
order ledger, and chase the gaps at month end. That manual loop is slow,
error-prone, and does not scale past a few hundred transactions a day. PayBridge
exists to make multi-provider settlement automatic, auditable, and correct by
construction — so a finance team can trust the numbers without re-checking them.

The domain carries hard constraints that the merchant rarely states but always
needs: every charge must be idempotent so a retried request never double-bills;
every inbound webhook must be signature-verified so a forged event cannot move
money; and every state change must land in an append-only audit trail so a
dispute can be reconstructed months later.

## 2. What problem does it solve?

PayBridge ingests transactions from each connected provider, normalizes them
into one ledger model, and reconciles them against the merchant's orders in near
real time. Mismatches (missing capture, duplicate refund, currency drift) are
surfaced as typed exceptions a human can act on, instead of being discovered in
a spreadsheet weeks later. Settlement reports are generated per provider and per
period, and are reproducible: the same inputs always yield the same report.

It removes the manual export-match-chase loop, shortens month-end close from
days to minutes, and turns "we think the numbers are right" into "the numbers
are provably right, and here is the audit trail."

## 3. What is its purpose?

The purpose is a settlement engine that is trustworthy by design: idempotent
writes, verified webhooks, an append-only audit log, and deterministic reports.
Everything else — dashboards, exports, alerting — is built on that core. The
measure of success is that a finance team stops reconciling by hand and starts
trusting PayBridge as the system of record for money movement.

# Capabilities

- id: provider-ingestion
  title: "Multi-provider transaction ingestion"
  summary: "Pull and normalize transactions from Stripe and Toss into one ledger model."
  surface: feature
- id: reconciliation-engine
  title: "Order-to-payment reconciliation"
  summary: "Match provider transactions against the merchant order ledger and surface typed mismatches."
  surface: feature
- id: idempotent-charges
  title: "Idempotent charge handling"
  summary: "Guarantee a retried charge request never double-bills via idempotency keys."
  surface: platform
- id: webhook-verification
  title: "Signed webhook verification"
  summary: "Verify provider webhook signatures before any state change is applied."
  surface: platform
- id: audit-trail
  title: "Append-only audit trail"
  summary: "Record every money-moving state change so a dispute can be reconstructed."
  surface: infrastructure
- id: settlement-reports
  title: "Deterministic settlement reports"
  summary: "Generate per-provider, per-period reports that are byte-reproducible."
  surface: feature

# Scenarios

- slug: purchase-flow
  title: "Purchase and capture"
  flow: |
    A buyer pays through a connected provider; PayBridge records the authorization,
    captures it idempotently, and writes the resulting ledger entry plus an audit
    record. A retry of the same request reuses the idempotency key and never
    double-charges.

- slug: refund-flow
  title: "Refund and reconcile"
  flow: |
    A merchant issues a refund; PayBridge applies it against the original charge,
    rejects a duplicate refund, and reconciles the refunded amount back into the
    settlement report for the period.

- slug: settlement-flow
  title: "Month-end settlement"
  flow: |
    At period close, PayBridge reconciles every provider transaction against the
    order ledger, surfaces any typed mismatch for a human to resolve, and emits a
    deterministic settlement report per provider.
