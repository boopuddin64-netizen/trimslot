# Open questions for the lawyer

> **INTERNAL – for the owner and the lawyer only. Do NOT publish this file or the legal pack** (no web page, no public repository, no app screen). It contains business details such as fees, charges, the split of processing costs and internal settings. Only files 01–06 are turned into public pages, and they must not quote those numbers.

> **DRAFT – not legal advice – lawyer review required.**

Numbered so you can answer by number. "Today" = what the app does now (see `08-app-behaviour-reference.md`).

## A. Business and structure
1. Which entity will operate TrimSlot (CAC company? business name?) and what are the exact legal name, RC number and registered address? Who signs for the company?
2. Is the "marketplace / platform, barbers are independent" structure safe under Nigerian law — could barbers or customers argue agency, employment, or that TrimSlot sells the service itself? Is any wording in the Terms (queue ordering, approval of shops, rules for no-shows) risky for that argument?
3. Does collecting payments and splitting them through Paystack subaccounts mean TrimSlot needs any CBN or other licence, or is it safely just a Paystack customer? Do we ever "hold" funds (credits are not cash; refunds go through Paystack; the barber's share goes straight from Paystack to the barber)?
4. Which states will we launch in, and are there state/local rules for barber shops or online platforms to include?

## B. Terms of Service
5. **Limitation of liability** (s.9): is the cap (greater of amount paid and the liability cap, an admin setting that is **not set yet**) enforceable against consumers? What must we not exclude (injury, negligence, statutory consumer rights)?
6. **Dispute resolution** (s.12): courts, mediation or arbitration? Is compulsory arbitration with consumers permitted/advisable? Which centre and seat? Is there a small-claims or Lagos multi-door route to recommend?
7. Age: the Service is 18+ and the app has no feature for booking on behalf of a child. Do we need an age check? How to treat children's data if one signs up?
8. Can we change the Terms with in-app notice only, and what notice period is reasonable?
9. Clickwrap: the app now has **mandatory tick-boxes and an acceptance log** (document, version, date/time, IP address, browser/user agent) and asks users to re-accept when a version is raised. Is that sufficient? Is storing IP and user agent proportionate, and for how long (today: until the account is deleted, then nulled)?
10. Content licence (reviews, photos) and defamation risk for reviews and reports. Do we need a notice-and-takedown process?

## C. Refunds, cancellations, credits (the most sensitive area)
11. **Missed session = no refund, 1 credit (same barber, {{credit_expiry_days}} days, not cashable).** Is this lawful for prepaid online bookings under the FCCPA 2018? Must a refund be offered instead (or in addition) in some cases?
12. **Cancelling in time a booking paid online:** now a **refund** (never a credit), pending staff approval and **auto-approved after {{refund_auto_approve_hours}} hour(s)** if nobody decides; staff may reject with a written reason. Is the auto-approval time acceptable (it is done by a scheduled check, so it can lag)? On what grounds may staff reject? What refund timeline do we promise? A missed booking is a credit, never a refund.
13. Is a **{{credit_expiry_days}}-day credit expiry** lawful and fair? Does it need to be longer, or refundable on expiry?
14. Is the **{{cancel_cutoff_min}}-minute cancel window** (an admin setting) reasonable and sufficiently disclosed at the time of booking and payment?
15. **Paystack processing fee**: part of it (the customer's share, see 24a) is added at checkout as a "booking fee". Is that lawful, is the disclosure adequate, and must it be refunded when the booking is refunded (see 24b)?
16. Late / duplicate payments are refunded automatically to the original method. Any time limit we must promise?
17. **Chargebacks and refunds of split payments.** The app has no mechanism that takes a refund or chargeback back from a barber's balance or payouts, and the Barber Agreement no longer says it does. Who bears a chargeback? Is a recovery right against the barber needed? See also 55.

## D. Plans
18. Is a plan (a one-time prepaid pack of sessions with expiry and no refund of unused sessions) acceptable? Does a **cooling-off period** apply to distance sales of prepaid services?
19. If a barber leaves or is removed with customers holding unused paid sessions, what must we do (refund, transfer, hold)? Today: manual admin handling only.
20. Is "expiry with no refund" enforceable, and does it need to be in a prominent summary at the point of purchase?
21. Is the plan a "subscription" in any legal sense (no auto-renewal today)?

## E. Barber Agreement
22. Independent-contractor language and **indemnity** (s.13): enforceable against small traders? Reasonable?
23. **Cash-commission balance and netting** — is deducting a debt from later Paystack payouts (raising our transaction charge) contractually and legally sound? Are interest/recovery clauses needed? What if the barber disputes the balance?
24. **Fees:** TrimSlot's charge is {{platform_charge_percent}} % of the price (minimum ₦{{platform_charge_min_naira}}) on every booking. {{commission_percent}} % of that is owed as commission on cash bookings. Is the commission-on-cash model lawful and clearly disclosed? VAT on our fees?
24a. **Booking fee and three-way split of the payment-processor fee.** The payment processor's fee is split between the customer (shown as a "booking fee" line at checkout, currently {{fee_share_customer_percent}} %), the barber (currently {{fee_share_barber_percent}} %, taken from the payout) and TrimSlot (currently {{fee_share_platform_percent}} %). We do not state the processor's fee as a fixed number, because its rates can change. Is this disclosure at checkout and in the Barber Agreement enough? Is a separate "booking fee" line lawful and clear under consumer law? Is VAT charged on it?
24b. **Refund of the booking fee.** On a refund because the customer cancelled in time (or the barber could not serve), the app refunds the **whole amount charged, including the booking fee**. A credit (after a missed booking) is for the **price only**; the booking fee is not credited. Is that right? May we keep the booking fee on a customer cancellation?
24c. **Private share links.** Barbers are no longer listed to all customers. A customer sees a barber only through the barber's private link (or after a booking). Does the link or the saved "My barbers" list raise any privacy, consumer-law or competition concern, and should the Privacy Policy say more?
25. **Insurance:** require or only recommend public-liability insurance? Minimum cover?
26. **Tax:** do we have any duty to withhold or report barbers' income as a platform? How should the Agreement describe VAT?
27. **Suspension/removal:** is a unilateral right to suspend with notice-after fair? What happens to upcoming bookings, plans and balances?
28. ID/KYC for barbers and the legal basis for storing ID documents (not collected today).
29. Is a short **anti-circumvention** or exclusivity clause needed or wise?
30. Non-verified bank account name: we allow the barber to type the account name when Paystack's lookup is unavailable (marked "not verified"). Any risk or wording to add?

## F. Privacy / NDPA
31. Are we a **data controller of major importance** and must we register with the NDPC now? Do we need a **DPO** and an annual **audit return**? What are the thresholds in the NDPC's 2025 implementation directive (GAID)?
32. Lawful basis for the **reliability label** shown to barbers and for **barber private notes** about customers. DPIA needed? Right to object? Is this "profiling"?
33. **International transfers:** database in London (Supabase), hosting in London (Vercel), Paystack group, and Resend (e-mail provider, used only if e-mail verification is switched on). Which transfer mechanism and documents (SCCs / adequacy / NDPC approvals) do we need, and what notices?
34. **Retention periods:** the app deletes automatically, on admin-set periods, from a clean-up job that runs at most hourly but starts from the scheduled sweep (daily by default; see 58): webhook records, notifications, stale push subscriptions, admin alerts, rate-limit records, soft-deleted accounts (erased or anonymised). Bookings, payments and the audit trail are **kept** (anonymised after account deletion). What periods should we publish (6 years for financial records?)
35. **Data-subject rights:** there is now a self-service JSON export and account deletion (anonymisation, financial records kept). Private notes that barbers keep about customers are **excluded from the export** — acceptable? Barber deletion with open obligations becomes an admin-handled request — acceptable? Time limits for e-mail requests?
36. Raw Paystack **webhook payloads** are stored for {{retention_events_days}} days ({{retention_bad_events_days}} days if the signature was invalid) and may contain payer details (e-mail, card type, last 4 digits, bank, IP address). Is that proportionate under data minimisation, or should the period be shorter / the payload trimmed?
37. **Barbers as controllers** of customer data they receive — is a data-sharing clause enough?
38. Breach notification: 72 hours to NDPC; to individuals "without undue delay" — wording OK?
39. Is a **cookie banner** needed? Today only one strictly-necessary cookie plus local-storage preferences; no analytics/ads.
40. **Push notifications:** is our consent text enough? Any rule for messages shown on lock screens?

## G. Compliance and operations
41. Anything required by the FCCPC for online platforms (registration, complaint handling, price display)?
42. Which consumer-facing notices must appear in the app before payment (cancellation policy, fee disclosure)?
43. Paystack live-mode onboarding: which of our documents will Paystack ask for and are they sufficient?
44. Insurance for the platform itself (professional indemnity, cyber).
45. Do we need a separate **Acceptable Use**, **Complaints** or **Community Guidelines** page?

## H. Product facts the owner must decide (so the documents can be finalised)
46. Final company name/address/e-mail/phone/domain.
47. Final fee levels: the three-way split of the payment-processor fee, TrimSlot's charge and the commission on cash bookings are admin settings (no fixed numbers are written in the documents). Confirm the levels to publish, and that the split matches what Paystack really charges.
48. Decided in the product: early-cancelled online payments are **refunded, never credited** (the old switch `credit_on_early_cancel_prepaid` is ignored). Barber "Not served" prepaid bookings are also refunded (product decision — confirm). Rejection grounds and wording still to decide.
49. Credit expiry days ({{credit_expiry_days}} today); plan limits; plan refund setting. All are admin settings and the public pages follow them.
50. Built: acceptance tick-boxes and log, self-service export/delete, automatic retention clean-up, admin alerts, customer profile pictures. Still to decide: plan-session refund on shop removal.
51. **Profile pictures:** customers may upload a photo that barbers they book with can see. Consent basis, children (the app has no feature for booking for a child), and moderation (admin can remove a photo with a reason).
52. **Liability cap:** set the amount (admin Controls) once the lawyer confirms; until then the Terms show a placeholder.
53. **Push subscriptions and failed-login records.** A push subscription stores a browser description ("user agent") and belongs to the browser, so it moves to another account that turns push on in the same browser. Failed-log-in counters (`rate_limits`) keep the typed e-mail or phone and the IP address for {{retention_rate_limit_hours}} hours. Is the notice in the Privacy Policy enough?
54. **Loyalty credits and removing credits.** If the owner switches the loyalty reward on, a customer earns a free credit (valid 90 days) every Nth visit. Staff can also revoke a credit (mistake, fraud, account closed). Is the revocation clause in the Terms and Refund Policy acceptable, especially for a credit that replaced a paid, missed session?
55. **Refunds of split payments.** When a split payment is refunded, how does Paystack take the money back (from the barber's subaccount, from TrimSlot's balance, or both), and who bears the booking fee and Paystack's own fee? Today we assume nothing and promise the customer a full refund of what they were charged.
56. **Debt settled during a checkout.** The netted amount is fixed when a barber's customer starts to pay. If the barber's balance is settled in the meantime, the payment still takes the netted amount from the barber, and the app does not pay it back automatically (staff review). Acceptable, or must it be corrected automatically?
57. **Credit value for a missed plan session.** The credit equals the service price on the booking, not the per-session share of the plan price, so it can be worth more than the session cost the customer. Is that intended (owner) and fair to the barber, who already received the plan payment?
58. **When the scheduled checks run.** On Vercel's free plan the sweep (auto-approving refunds, closing abandoned tries, reminders, retention clean-up) runs once a day; an external one-minute timer makes it near-instant. The documents say so. Owner: which will be used at launch? Lawyer: is a refund auto-approval that can lag up to a day acceptable?
59. **Notification consent card.** The card in the app is short and has no privacy link (see document 06). Is it enough?
60. **Help-request text.** A customer can write a short free-text message when they ask for urgent help with a booking. It is stored with the booking, may be copied into a staff report, is included in the customer's data export, is blanked when the account is deleted, and is removed by the retention clean-up after the notifications period. Is that the right lawful basis, retention and notice? Should the help button warn people not to write sensitive details (health, for example)?
61. **E-mail verification code data (OTP).** If e-mail verification is switched on, we store for a few minutes a one-way hash of the one-time code, its expiry time and the wrong-try count, and send the code through Resend (a processor outside Nigeria). The hash is cleared when used or replaced and within about a day after it expires. Is that retention and the Resend contract/transfer mechanism (DPA, SCCs) enough? Is a separate notice needed when the switch is turned on?
62. **Phone sharing.** A customer sees the barber's phone number and WhatsApp link only on a paid, confirmed or arrived booking; the barber sees the customer's phone and WhatsApp link on the barber's own bookings. Is showing these numbers to the other party covered by the Privacy Policy as written, and do we need consent, or a rule about how the numbers may be used (no marketing, no saving)?
63. **Taking a debt from online payments (decision for the owner/lawyer).** The Barber Agreement now says only: "If you owe TrimSlot an amount, we may take it from future online payments to you, and the app shows your balance." We removed the earlier public promises "we never take more than you owe" and "the charge is never more than the price", so the public text no longer states a cap. Is the generic wording enough for a fair, enforceable term, or do you want a cap, a notice step or a dispute route written in (without publishing the formula)? The real rules are in document 08.
