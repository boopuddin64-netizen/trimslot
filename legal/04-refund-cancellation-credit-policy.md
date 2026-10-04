# Refund, Cancellation and Credit Policy

> **DRAFT – not legal advice – lawyer review required.** Replace every `[BRACKETED]` item. See `00-open-questions-for-lawyer.md`.
> This policy describes what the app does today. The numbers on this page are admin settings and the published page reads them live, so changing a setting in the admin Controls page updates the page without a code change.

**Effective date:** [EFFECTIVE DATE]  **Version:** [VERSION]

This policy is part of the [Terms of Service](terms.html). "**Barber**" means the independent shop you booked with. Times are Lagos time.

## 1. At a glance

**One booking gets one outcome: a refund *or* a credit, never both.** An in-time cancellation of a prepaid booking is a **refund**. A missed booking is a **credit**.

| Situation | What happens |
|---|---|
| You cancel **{{cancel_cutoff_min}} minutes or more** before your appointment | Free. Slot is released. Paid online → a **refund** (after approval, section 3). Paid by plan session or credit → it is **returned to you automatically**. Pay on arrival → nothing to pay. |
| You want to cancel **less than {{cancel_cutoff_min}} minutes** before | You **cannot cancel in the app**. Contact the barber. If you do not turn up it is a **missed session** (section 4). |
| You **do not turn up** and the barber marks you a no-show (only possible after your appointment time) | Paid session: **no refund**, but you get **1 session credit with the same barber**, valid **{{credit_expiry_days}} days**, **not cashable**. Pay on arrival: nothing is charged; the no-show stays on your record. |
| The **barber cannot serve you** ("Not served") | Paid online: a **refund** (section 5). Plan session / credit: returned automatically. |
| You started paying but **did not finish** | Not charged. The booking becomes "Incomplete" after **{{payment_hold_min}} minutes** and the slot is released (section 6). |
| You were **charged twice**, or your payment arrived **late / after the slot was taken** | Not a booking. The extra or late payment is **refunded automatically** to your original payment method (section 7). |

## 2. Cancelling a booking

2.1 You may cancel in the app **until {{cancel_cutoff_min}} minutes before your appointment starts.** The cut-off is a TrimSlot setting and is shown on the booking before you pay. [LAWYER/OWNER: confirm {{cancel_cutoff_min}} minutes is the policy to publish.]

2.2 After the cut-off the booking is "locked" so the barber's time is protected. If something genuinely came up, contact the barber; the barber may mark the booking "Not served" or leave it for you to arrive.

2.3 If a barber is removed or suspended, or a customer account is removed, upcoming bookings may be cancelled by us. Paid online bookings are then refunded (flagged for refund and requested from Paystack); plan sessions and credits are returned.

## 3. Cancelling a booking you paid for online (in time): a refund

3.1 When you cancel in time a booking that you **paid online**, you are entitled to a **refund** of what you paid for the booking. You do **not** also receive a credit.

3.2 The refund starts as **"refund pending"** and waits for approval by TrimSlot staff. If staff approve it, the refund request is sent to Paystack at once. If staff have **not approved or rejected it within {{refund_auto_approve_hours}} hour(s)** of your cancellation, it is **approved automatically** and the refund request is sent to Paystack. You are notified when it is approved. You can see the status ("refund pending", "refunded") on your booking.

3.3 Staff may **reject** a refund only for a stated reason (for example where the service was in fact delivered). [LAWYER/OWNER: define the permitted grounds.] You are told the reason, you receive neither a refund nor a credit for that booking, and you can contest it with "Report a problem" or by e-mail to [EMAIL].

3.4 If you paid with a **plan session** or a **session credit**, cancelling in time simply **returns** the session or credit to you, with the same expiry as before.

3.5 [PROPOSED: refunds, when approved, are paid back to the original payment method within [5–10] working days; the time your bank takes is outside our control.] If Paystack cannot process the refund, our staff are alerted and retry it; you do not need to ask again.

3.6 **Older bookings.** Before this rule took effect some cancelled prepaid bookings were marked "credit pending". TrimSlot staff decide each of those individually (a credit or a refund, never both).

## 4. Missed sessions and no-shows

4.1 A barber can mark a booking **no-show** only after the scheduled time has passed and you have not arrived. Do check-in with "I'm Here" when you arrive.

4.2 **If you had paid** (online or with a plan session): there is **no refund**, but you receive **one session credit with the same barber**, worth the price of the missed booking. The credit is issued straight away; it does not wait for approval. A booking never gets both a credit and a refund.

4.3 Credit rules:
* **Same barber only**, not usable at other shops.
* **Expires {{credit_expiry_days}} days after it is issued** (a TrimSlot setting). It must be used for an appointment that **starts before it expires**.
* **Not cashable** — it cannot be exchanged for money, transferred or sold.
* Use it on a service **priced at or below the credit's value**; there is no change given and no top-up in the app. [OWNER: confirm top-up is not possible.]
* A booking you pay for with a credit and then miss does **not** earn a new credit.
* If you cancel in time a booking paid with a credit, the credit comes back to you (still with the original expiry).
* A missed **plan session** counts as used: the session is not restored, and you receive the credit described above.

4.4 If you did not pay in advance (pay on arrival), nothing is charged for a no-show. The barber's record shows it, and repeated no-shows may lead to a "reliability" label and restrictions.

4.5 If you believe a no-show was marked wrongly, report it in the app ("Report a problem") or e-mail [EMAIL]. We may reverse it and cancel the credit.

## 5. When the barber cannot serve you

If the barber marks the booking "**Not served**": a **plan session or credit is returned automatically**; an **online payment** is **refunded** through the same pending-approval process as section 3 (not a credit). Pay-on-arrival bookings are simply voided.

## 6. Incomplete payments

6.1 When you choose "Pay now", the slot is held for **{{payment_hold_min}} minutes**. If you do not complete payment, or you leave and cancel, the attempt is marked **Incomplete**, **you are not charged**, and the barber does not see it.

6.2 If payment is confirmed by Paystack a little after the hold ended and the slot is **still free**, the booking is confirmed. If the slot was taken meanwhile, see section 7.

6.3 If money was taken but the page showed an error, tap "I've paid, check status" on the booking, or contact us with the booking number and Paystack reference. We can verify directly with Paystack.

## 7. Duplicate, late and mismatched payments

7.1 **Duplicate** (you paid twice for one booking or plan), **late** (payment arrived after the attempt closed) and **slot taken** (someone else booked the time first) payments are **never kept as bookings**. They are flagged "needs refund" and **a refund request is sent to Paystack automatically**; if that fails, we retry on a schedule and staff can action it.

7.2 You will see a notification. The refund goes to the **original payment method**. Time to arrive depends on Paystack and your bank [typically [5–10] working days]. 

7.3 If the amount Paystack reports does not match the price (other than Paystack's processing fee), the booking is **not confirmed automatically**; staff review it, and you are refunded if you were charged wrongly.

7.4 Paystack's **processing fee**, if charged on top, [is / is not] refunded with the payment. [OWNER/LAWYER: decide; the app currently refunds the transaction through Paystack, whose fee rules apply.]

## 8. Plans

Plan purchases and unused sessions are covered by the [Plan Terms](plan-terms.html). In short: unused sessions **expire when the plan ends** and are **not refunded**, unless the platform's plan refund setting is "case by case" and we agree one. A duplicate plan payment is refunded automatically (section 7).

## 9. Chargebacks and disputes with your bank

Please contact us first. If you start a chargeback, we will give your bank the records we hold. If a chargeback succeeds, we may cancel related bookings, plans or credits and recover the amount from the barber's balance where it was their fault.

## 10. How to ask for help

Use "Report a problem" on the booking, or contact [EMAIL] / [PHONE] with the booking number. We aim to reply within [2] working days. You can still complain to the FCCPC or take legal action; this policy does not remove any right you cannot lawfully give up.

## Open questions for the lawyer

> Numbers refer to `00-open-questions-for-lawyer.md`, which has the full list.

* **Q11.** Missed paid session: no refund, 1 credit, same barber, 30 days, no cash value. Lawful under the FCCPA 2018?
* **Q12.** In-time cancellation of an online-paid booking is now a refund (pending approval, auto-approved after the hold time). Are the hold time, the right to reject, and the refund timeline acceptable?
* **Q13.** Is the credit expiry ({{credit_expiry_days}} days) lawful and fair?
* **Q14.** Is the {{cancel_cutoff_min}}-minute cancel lock reasonable and sufficiently disclosed before payment?
* **Q15.** Paystack fee: refunded with the booking?
* **Q16.** Time limit to promise for duplicate/late payment refunds.
* **Q17.** Chargebacks.
