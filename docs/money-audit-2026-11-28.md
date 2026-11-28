# TrimSlot money audit, 28 Nov 2026

Scope: every code path that creates, moves, refunds or records money, checked against the live production database (read-only) and against Paystack's documented behaviour. Re-runnable checks: `scripts/money-audit.sql` (read-only SELECTs). Automated cases: `tests/money-audit.test.ts`.

## Result in one line

The arithmetic is exact: no kobo is missing in any record. Three things are not proven and need a decision or a Paystack check before the numbers can be called correct end to end.

## What was checked and passed

| Check | Result |
|---|---|
| Paid = amount + gateway fee passed to customer (16 payments with a breakdown) | 0 difference on all 16 |
| Amount = price + booking fee | 0 difference on all 16 |
| Split: barber payout + barber fee + platform charge + booking fee + netted debt = amount | 0 difference on all 16 |
| Commission ledger: remaining = amount - applied + reversed (8 rows) | 0 difference on all 8 |
| Netting: every payment that netted debt has that exact amount applied (3 payments) | matches, none reversed wrongly |
| A paid online booking with no successful payment | none |
| A successful payment whose booking is in a conflicting state | none |
| A booking marked refunded with no refund on its payment | none |
| Negative ledger adjustments (credit owed to a barber) | refused by the database (check constraint), now covered by a test |
| Fee model: total = payout + barber fee + platform charge + booking fee, across 5,000+ prices | passes to the kobo (new test) |

Totals at the time of the audit (test-mode data):
- 22 successful in-app payments, ₦93,806.60 paid in total (16 with a breakdown, 6 older ones without, see finding 4).
- 6 refunded payments, ₦13,451.13 returned to customers.
- Commission debt owed by barbers: ₦0.00.
- Unused session credits owed to customers: ₦3,000.00 (2 credits).

## Findings that need a decision or a check

### 1. Paystack fee split does not match the fee model (high)
The code sends `bearer_type: 'all'`. Paystack's documentation says: "Fees will be shared equally by the main account and all subaccounts." With one barber subaccount, that is 50/50. The code comment assumes the fee is split in thirds (customer, barber, TrimSlot). It is not.

Effect: the barber bears half of Paystack's actual fee on top of the barber fee shown to them. Measured so far: ₦490.42 across 13 test-mode payments.

Options: set `bearer_type: 'account'` (TrimSlot bears all Paystack fees). That matches the platform figure in `src/fees.ts` exactly. This changes money flow, so it needs your decision before any code change.

### 2. Refunds on split payments: unverified (high)
Paystack's public refund documentation does not say whether a refund on a split payment is taken from the barber's subaccount share or from TrimSlot's main balance. If it comes from TrimSlot, a refund costs TrimSlot the barber's share.

At risk if not reversed: ₦3,096.14 across 2 refunded payments (booking 110 and booking 123). Action: ask Paystack support, or run one refund in test mode and check the subaccount balance. The refund response also contains `deducted_amount` and `fully_deducted`, which the code does not record. Recording them would make this auditable.

### 3. Refunds return the Paystack fee the customer paid (medium, policy)
Six refunded payments returned ₦597.27 of Paystack fees that customers had paid on top of the price, plus ₦4.53 of fee on booking 123. Paystack normally does not return its own fee, so TrimSlot absorbs it. Decide whether refunds should exclude the fee.

### 4. Six older payments have no breakdown (medium)
Six successful payments (₦50,761.45 paid), including plans 10 and 11, have no recorded price, barber fee or payout. The barber's share for those cannot be audited from the database. Paystack's transaction records are the only source for them.

### 5. Fee passed to customers in older payments (low)
Nine older payments (₦1,626.38 in total) charged the customer the Paystack fee on top of the price. Newer payments do not. Confirm this was intended.

## What is not proven yet

- **Paystack settlement.** This audit proves TrimSlot's own records are consistent. It does not prove what Paystack actually paid to each subaccount and to TrimSlot. The sandbox has no Paystack key and cannot reach the Paystack API. The check needs the Paystack dashboard export or a key-backed run of the transaction verify call, comparing each payment's split against the figures above.
- **The barber fee split in finding 1** changes amounts that have already settled in test mode. Once live, it affects real barber payouts.

## How to re-run

1. Paste `scripts/money-audit.sql` into the Supabase SQL editor (or run it with psql). It is read-only.
2. Expected: every difference column is 0, and the "problem" checks return no rows.
3. Run `npx tsx scripts/test.ts tests/money-audit.test.ts` for the automated cases.

Test runs: 3 of 3 pass in the sandbox. The full suite shows the same 4 known sandbox-only failures (R1, R1b, R5, R6) as before this audit.
