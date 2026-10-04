# Open questions for the lawyer

> **DRAFT – not legal advice – lawyer review required.**

Numbered so you can answer by number. "Today" = what the app does now (see `08-app-behaviour-reference.md`).

## A. Business and structure
1. Which entity will operate TrimSlot (CAC company? business name?) and what are the exact legal name, RC number and registered address? Who signs for the company?
2. Is the "marketplace / platform, barbers are independent" structure safe under Nigerian law — could barbers or customers argue agency, employment, or that TrimSlot sells the service itself? Is any wording in the Terms (queue ordering, approval of shops, rules for no-shows) risky for that argument?
3. Does collecting payments and splitting them through Paystack subaccounts mean TrimSlot needs any CBN or other licence, or is it safely just a Paystack customer? Do we ever "hold" funds (credits are not cash; refunds go through Paystack)?
4. Which states will we launch in, and are there state/local rules for barber shops or online platforms to include?

## B. Terms of Service
5. **Limitation of liability** (s.9): is the cap (greater of amount paid and the liability cap, an admin setting that is **not set yet**) enforceable against consumers? What must we not exclude (injury, negligence, statutory consumer rights)?
6. **Dispute resolution** (s.12): courts, mediation or arbitration? Is compulsory arbitration with consumers permitted/advisable? Which centre and seat? Is there a small-claims or Lagos multi-door route to recommend?
7. Age: the Service is 18+, yet today an adult can book for a child. Allow it? How to treat children's data?
8. Can we change the Terms with in-app notice only, and what notice period is reasonable?
9. Clickwrap: the app now has **mandatory tick-boxes and an acceptance log** (document, version, date/time, IP address, browser/user agent) and asks users to re-accept when a version is raised. Is that sufficient? Is storing IP and user agent proportionate, and for how long (today: until the account is deleted, then nulled)?
10. Content licence (reviews, photos) and defamation risk for reviews and reports. Do we need a notice-and-takedown process?

## C. Refunds, cancellations, credits (the most sensitive area)
11. **Missed session = no refund, 1 credit (same barber, {{credit_expiry_days}} days, not cashable).** Is this lawful for prepaid online bookings under the FCCPA 2018? Must a refund be offered instead (or in addition) in some cases?
12. **Cancelling in time a booking paid online:** now a **refund** (never a credit), pending staff approval and **auto-approved after {{refund_auto_approve_hours}} hour(s)** if nobody decides; staff may reject with a written reason. Is the hold time acceptable? On what grounds may staff reject? What refund timeline do we promise? A missed booking is a credit, never a refund.
13. Is a **{{credit_expiry_days}}-day credit expiry** lawful and fair? Does it need to be longer, or refundable on expiry?
14. Is the **{{cancel_cutoff_min}}-minute cancel window** (an admin setting) reasonable and sufficiently disclosed at the time of booking and payment?
15. **Paystack processing fee** passed to the customer (the checkout adds it): is it lawful, is the disclosure adequate, and must it be refunded when the booking is refunded?
16. Late / duplicate payments are refunded automatically to the original method. Any time limit we must promise?
17. Chargebacks: can we recover from a barber's balance as the Barber Agreement says?

## D. Plans
18. Is a plan (a one-time prepaid pack of sessions with expiry and no refund of unused sessions) acceptable? Does a **cooling-off period** apply to distance sales of prepaid services?
19. If a barber leaves or is removed with customers holding unused paid sessions, what must we do (refund, transfer, hold)? Today: manual admin handling only.
20. Is "expiry with no refund" enforceable, and does it need to be in a prominent summary at the point of purchase?
21. Is the plan a "subscription" in any legal sense (no auto-renewal today)?

## E. Barber Agreement
22. Independent-contractor language and **indemnity** (s.13): enforceable against small traders? Reasonable?
23. **Cash-commission balance and netting** — is deducting a debt from later Paystack payouts (raising our transaction charge) contractually and legally sound? Are interest/recovery clauses needed? What if the barber disputes the balance?
24. **Fees:** ₦{{platform_fee_naira}} + {{platform_fee_percent}} % online; {{commission_percent}} % of that as commission on cash bookings. Is the commission-on-cash model lawful and clearly disclosed? VAT on our fees?
25. **Insurance:** require or only recommend public-liability insurance? Minimum cover?
26. **Tax:** do we have any duty to withhold or report barbers' income as a platform? How should the Agreement describe VAT?
27. **Suspension/removal:** is a unilateral right to suspend with notice-after fair? What happens to upcoming bookings, plans and balances?
28. ID/KYC for barbers and the legal basis for storing ID documents (not collected today).
29. Is a short **anti-circumvention** or exclusivity clause needed or wise?
30. Non-verified bank account name: we allow the barber to type the account name when Paystack's lookup is unavailable (marked "not verified"). Any risk or wording to add?

## F. Privacy / NDPA
31. Are we a **data controller of major importance** and must we register with the NDPC now? Do we need a **DPO** and an annual **audit return**? What are the thresholds in the NDPC's 2025 implementation directive (GAID)?
32. Lawful basis for the **reliability label** shown to barbers and for **barber private notes** about customers. DPIA needed? Right to object? Is this "profiling"?
33. **International transfers:** database in London (Supabase), hosting in London (Vercel), Paystack group. Which transfer mechanism and documents (SCCs / adequacy / NDPC approvals) do we need, and what notices?
34. **Retention periods:** the app now deletes automatically (hourly) on admin-set periods: webhook records, notifications, stale push subscriptions, admin alerts, soft-deleted accounts (erased or anonymised). Bookings, payments and the audit trail are **kept** (anonymised after account deletion). What periods should we publish (6 years for financial records?)
35. **Data-subject rights:** there is now a self-service JSON export and account deletion (anonymisation, financial records kept). Private notes that barbers keep about customers are **excluded from the export** — acceptable? Barber deletion with open obligations becomes an admin-handled request — acceptable? Time limits for e-mail requests?
36. Raw Paystack **webhook payloads** are stored (up to {{retention_events_days}} days) and may contain payer details. OK under data minimisation?
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
47. Final fee levels; who bears the Paystack fee.
48. Decided in the product: early-cancelled online payments are **refunded, never credited** (the old switch `credit_on_early_cancel_prepaid` is ignored). Barber "Not served" prepaid bookings are also refunded (product decision — confirm). Rejection grounds and wording still to decide.
49. Credit expiry days ({{credit_expiry_days}} today); plan limits; plan refund setting. All are admin settings and the public pages follow them.
50. Built: acceptance tick-boxes and log, self-service export/delete, automatic retention clean-up, admin alerts, customer profile pictures. Still to decide: plan-session refund on shop removal.
51. **Profile pictures:** customers may upload a photo that barbers they book with can see. Consent basis, children (the app allows an adult to book for a child), and moderation (admin can remove a photo with a reason).
52. **Liability cap:** set the amount (admin Controls) once the lawyer confirms; until then the Terms show a placeholder.
