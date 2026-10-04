# Open questions for the lawyer

> **DRAFT – not legal advice – lawyer review required.**

Numbered so you can answer by number. "Today" = what the app does now (see `08-app-behaviour-reference.md`).

## A. Business and structure
1. Which entity will operate TrimSlot (CAC company? business name?) and what are the exact legal name, RC number and registered address? Who signs for the company?
2. Is the "marketplace / platform, barbers are independent" structure safe under Nigerian law — could barbers or customers argue agency, employment, or that TrimSlot sells the service itself? Is any wording in the Terms (queue ordering, approval of shops, rules for no-shows) risky for that argument?
3. Does collecting payments and splitting them through Paystack subaccounts mean TrimSlot needs any CBN or other licence, or is it safely just a Paystack customer? Do we ever "hold" funds (credits are not cash; refunds go through Paystack)?
4. Which states will we launch in, and are there state/local rules for barber shops or online platforms to include?

## B. Terms of Service
5. **Limitation of liability** (s.9): is the cap (greater of amount paid and ₦[AMOUNT]) enforceable against consumers? What must we not exclude (injury, negligence, statutory consumer rights)?
6. **Dispute resolution** (s.12): courts, mediation or arbitration? Is compulsory arbitration with consumers permitted/advisable? Which centre and seat? Is there a small-claims or Lagos multi-door route to recommend?
7. Age: the Service is 18+, yet today an adult can book for a child. Allow it? How to treat children's data?
8. Can we change the Terms with in-app notice only, and what notice period is reasonable?
9. Clickwrap: the app currently has **no acceptance tick-box and no acceptance log**. What wording and records do we need for customers and barbers (version, date, IP)?
10. Content licence (reviews, photos) and defamation risk for reviews and reports. Do we need a notice-and-takedown process?

## C. Refunds, cancellations, credits (the most sensitive area)
11. **Missed session = no refund, 1 credit (same barber, 30 days, not cashable).** Is this lawful for prepaid online bookings under the FCCPA 2018? Must a refund be offered instead (or in addition) in some cases?
12. **Cancelling in time a booking paid online:** today the money is "credit pending" and *not* refunded automatically; staff follow up. Is that acceptable? Should the policy promise a full refund, a refund option, or credit-only? What timeline?
13. Is a **30-day credit expiry** lawful and fair? Does it need to be longer, or refundable on expiry?
14. Is the **fixed 30-minute cancel window** reasonable and sufficiently disclosed at the time of booking and payment?
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
24. **Fees:** ₦10 + 0.15 % online; 50 % of that as commission on cash bookings. Is the commission-on-cash model lawful and clearly disclosed? VAT on our fees?
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
34. **Retention periods:** what to publish for accounts, bookings, payments (6 years?), notifications, logs, backups? Most are **not auto-deleted** today.
35. **Data-subject rights:** time limits and procedure; we have no self-service export/delete yet. Is e-mail handling enough at launch?
36. Raw Paystack **webhook payloads** are stored (up to 400 days) and may contain payer details. OK under data minimisation?
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
48. Whether early-cancelled online payments are refunded, credited, or both (admin switch `credit_on_early_cancel_prepaid`).
49. Credit expiry days (30 today); plan limits; plan refund setting.
50. Whether to build: acceptance tick-boxes, self-service export/delete, automatic retention clean-up, plan-session refund on shop removal.
