# Refund, Cancellation and Credit Policy

> **DRAFT – not legal advice – lawyer review required.** Replace every `[BRACKETED]` item. See `00-open-questions-for-lawyer.md`.
> This policy describes what the app does today. The numbers on this page are admin settings and the published page reads them live, so changing a setting in the admin Controls page updates the page without a code change.

<div class="plain-summary">
<p class="ps-title"><b>In plain words</b></p>
<ul>
<li>You can cancel in the app up to {{cancel_cutoff_min}} minutes before your visit.</li>
<li>If you cancel in time and you paid online, you get a refund. TrimSlot staff approve it. If no one decides in {{refund_auto_approve_hours}} hour(s), it is approved by itself.</li>
<li>If you paid with a plan session or a credit, you get it back.</li>
<li>If you miss a visit that you paid for, you get no refund. You get one credit with the same barber instead. It lasts {{credit_expiry_days}} days. You cannot cash it out.</li>
<li>If the barber cannot serve you, you get a refund. If you pay twice, or your payment comes too late, you also get a refund.</li>
<li>One booking gets a refund or a credit. It never gets both.</li>
</ul>
<p class="ps-note">This is a short summary. The full text below is what counts.</p>
</div>

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
| You started paying but **did not finish** | Not charged. **No time is reserved while you pay.** After **{{payment_hold_min}} minutes** the try closes and the booking becomes "Incomplete" (section 6). |
| You were **charged twice**, or your payment arrived **after someone else's payment took the time** | Not a booking. The extra payment, or the payment for the time that was taken, is **refunded automatically** to your original payment method (section 7). A payment that arrives late for a time that is **still free** confirms the booking (section 6.2). |

## 2. Cancelling a booking

2.1 You may cancel in the app **until {{cancel_cutoff_min}} minutes before your appointment starts.** The cut-off is a TrimSlot setting and is shown on the booking before you pay. [LAWYER/OWNER: confirm {{cancel_cutoff_min}} minutes is the policy to publish.]

2.2 After the cut-off the booking is "locked" so the barber's time is protected. If something genuinely came up, contact the barber; the barber may mark the booking "Not served" or leave it for you to arrive.

2.3 If a barber is removed or suspended, or a customer account is removed, upcoming bookings may be cancelled by us. Paid online bookings are then refunded (flagged for refund and requested from Paystack); plan sessions and credits are returned.

## 3. Cancelling a booking you paid for online (in time): a refund

3.1 When you cancel in time a booking that you **paid online**, you are entitled to a **refund** of what you paid for the booking. You do **not** also receive a credit.

3.2 The refund starts as **"refund pending"** and waits for approval by TrimSlot staff. If staff approve it, the refund request is sent to Paystack at once. If staff have **not approved or rejected it within {{refund_auto_approve_hours}} hour(s)** of your cancellation, it is **approved automatically** and the refund request is sent to Paystack. The automatic approval is done by a scheduled check, so it happens at the next check after that time: within minutes if TrimSlot runs the check every minute, otherwise at the daily run. [OWNER: confirm which schedule is in use.] You are notified when it is approved. You can see the status ("refund pending", "refunded") on your booking.

3.3 Staff may **reject** a refund only for a stated reason (for example where the service was in fact delivered). [LAWYER/OWNER: define the permitted grounds.] You are told the reason, you receive neither a refund nor a credit for that booking, and you can contest it with "Report a problem" or by e-mail to [EMAIL].

3.4 If you paid with a **plan session** or a **session credit**, cancelling in time simply **returns** the session or credit to you, with the same expiry as before.

3.5 [PROPOSED: refunds, when approved, are paid back to the original payment method within [5–10] working days; the time your bank takes is outside our control.] If Paystack cannot process the refund, our staff are alerted and retry it; you do not need to ask again.

3.6 **Older bookings.** Before this rule took effect some cancelled prepaid bookings were marked "credit pending". TrimSlot staff decide each of those individually (a credit or a refund, never both).

## 4. Missed sessions and no-shows

4.1 A barber can mark a booking **no-show** only after the scheduled time has passed and you have not arrived. Do check-in with "I'm Here" when you arrive.

4.2 **If you had paid** (online or with a plan session): there is **no refund**, but you receive **one session credit with the same barber**, worth the price of the missed booking. The credit is worth the **service price on the missed booking**; for a missed plan session that is the price of the service booked, even though the session cost you a share of the plan price. [OWNER: confirm; see question 57.] The credit is issued straight away; it does not wait for approval. A booking never gets both a credit and a refund.

4.3 Credit rules:
* **Same barber only**, not usable at other shops.
* **Expires {{credit_expiry_days}} days after it is issued** (a TrimSlot setting). It must be used for an appointment that **starts before it expires**.
* **Not cashable** — it cannot be exchanged for money, transferred or sold.
* Use it on a service **priced at or below the credit's value**; there is no change given and no top-up in the app. [OWNER: confirm top-up is not possible.]
* A booking you pay for with a credit and then miss does **not** earn a new credit.
* **Loyalty credits.** If TrimSlot switches the loyalty reward on, you earn a credit with a barber after every {{loyalty_every_n}} completed visits with that barber (worth ₦{{loyalty_credit_naira}}, valid 90 days from the day it is issued). It follows the same rules as other credits.
* **Removal.** TrimSlot staff may remove (revoke) a credit that was issued by mistake or obtained unfairly or by fraud, or when an account is closed for breaking the Terms. You are told in the app and given the reason. [LAWYER: confirm; see question 54.]
* If you cancel in time a booking paid with a credit, the credit comes back to you (still with the original expiry).
* A missed **plan session** counts as used: the session is not restored, and you receive the credit described above.

4.4 If you did not pay in advance (pay on arrival), nothing is charged for a no-show. The barber's record shows it, and repeated no-shows can change the "reliability" label that barbers see.

4.5 If you believe a no-show was marked wrongly, report it in the app ("Report a problem") or e-mail [EMAIL]. We may reverse it and cancel the credit.

## 5. When the barber cannot serve you

If the barber marks the booking "**Not served**": a **plan session or credit is returned automatically**; an **online payment** is **refunded** through the same pending-approval process as section 3 (not a credit). Pay-on-arrival bookings are simply voided.

## 6. Incomplete payments

6.1 When you choose "Pay now", **no slot is reserved while you pay, and the first confirmed payment for a time wins.** The attempt stays open for **{{payment_hold_min}} minutes**. If you do not complete payment, or you leave and cancel, the attempt is marked **Incomplete**, **you are not charged**, and the barber does not see it.

6.2 If Paystack confirms your payment after the attempt closed, **and the time is still free** (and the shop is still open for bookings), the booking is **confirmed**. This does not depend on when the cleaning-up check happens to run. If the time was taken meanwhile, the payment is refunded (section 7). An attempt that **you cancelled yourself** is never revived: a payment that arrives for it is refunded.

6.3 If money was taken but the page showed an error, tap "I've paid, check status" on the booking, or contact us with the booking number and Paystack reference. We can verify directly with Paystack.

## 7. Duplicate, late and mismatched payments

7.1 **Duplicate** (you paid twice for one booking or plan), **too late** (the payment arrived after the attempt closed and the time was no longer free, or you had cancelled it) and **time taken** (someone else's payment for that time was confirmed first) payments are **never kept as bookings**. They are flagged "needs refund" and **a refund request is sent to Paystack automatically**; if that fails, we retry on a schedule and staff can action it. A payment that arrives late for a time that is still free is not in this group: it confirms the booking (6.2).

7.2 You get a notification in the app for each of these cases (a second payment, a late payment, and a payment for a time that was taken). The refund goes to the **original payment method**. Time to arrive depends on Paystack and your bank [typically [5–10] working days].

7.3 If the amount Paystack reports does not match the price (other than Paystack's processing fee), the booking is **not confirmed automatically**; staff review it, and you are refunded if you were charged wrongly.

7.4 **Booking fee.** When you pay online you pay the price plus a small, clearly labelled **booking fee**, which is part of the payment-processor fee (the current share is {{fee_share_customer_percent}}%). When a payment is refunded (in-time cancellation, "not served", duplicate, late or slot-taken payment), you get back **everything you were charged, including the booking fee**. A **credit** (for a missed booking) is for the **price only**; the booking fee is not turned into credit. Bookings paid by plan session, credit or on arrival have no booking fee. [LAWYER: confirm this treatment; see question 24b.]

## 8. Plans

Plan purchases and unused sessions are covered by the [Plan Terms](plan-terms.html). In short: unused sessions **expire when the plan ends** and are **not refunded**, unless the platform's plan refund setting is "case by case" and we agree one. A duplicate plan payment is refunded automatically (section 7).

## 9. Chargebacks and disputes with your bank

Please contact us first. If you start a chargeback with your bank, we will give your bank the records we hold. If a chargeback succeeds, we may cancel related bookings, plans or credits. [LAWYER/OWNER: the app has no automatic way to recover a chargeback from a barber; decide whether a recovery right is needed. See question 17.]

## 10. How to ask for help

Use "Report a problem" on the booking, or contact [EMAIL] / [PHONE] with the booking number. We aim to reply within [2] working days and to resolve the complaint within [30] days (the same as Terms of Service 12.1). You can still complain to the FCCPC or take legal action; this policy does not remove any right you cannot lawfully give up.

## Open questions for the lawyer

> Numbers refer to `00-open-questions-for-lawyer.md`, which has the full list.

* **Q11.** Missed paid session: no refund, 1 credit, same barber, {{credit_expiry_days}} days, no cash value. Lawful under the FCCPA 2018?
* **Q12.** In-time cancellation of an online-paid booking is now a refund (pending approval, auto-approved after {{refund_auto_approve_hours}} hour(s)). Is the auto-approval time, the right to reject, and the refund timeline acceptable?
* **Q13.** Is the credit expiry ({{credit_expiry_days}} days) lawful and fair?
* **Q14.** Is the {{cancel_cutoff_min}}-minute cancel lock reasonable and sufficiently disclosed before payment?
* **Q15.** Booking fee (the customer's share of the processor fee): refunded in full with the booking on a refund, not credited on a credit. Right? (See 24b.)
* **Q16.** Time limit to promise for duplicate/late payment refunds.
* **Q17.** Chargebacks.
