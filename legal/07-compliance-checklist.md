# Compliance Checklist (short)

> **INTERNAL – for the owner and the lawyer only. Do NOT publish this file or the legal pack** (no web page, no public repository, no app screen). It contains business details such as fees, charges, the split of processing costs and internal settings. Only files 01–06 are turned into public pages, and they must not quote those numbers.

> **DRAFT – not legal advice – lawyer review required.** This is a to-do list for the owner and the lawyer/accountant, not a statement of what the law requires. Tick, date and note who did it.

| # | Item | Why / what to do | Who | Status |
|---|---|---|---|---|
| **Company** | | | | |
| 1 | **CAC registration** | Register a company (Limited by shares is usual) or at minimum a business name with the Corporate Affairs Commission under the Companies and Allied Matters Act 2020. Needed for a bank account, Paystack live mode, contracts and liability protection. Record RC / BN number in all documents. | Owner + lawyer | ☐ |
| 2 | Registered address, directors, shareholders, PSC (beneficial-owner) filing | CAMA requires a persons-with-significant-control register / filing. | Lawyer | ☐ |
| 3 | Business bank account in the company's name | Needed for Paystack settlement and our fee income. | Owner | ☐ |
| 4 | Domain, brand and trademark | Buy the final domain; consider trademark search/registration for "TrimSlot". Replace the Vercel preview URL in all documents. | Owner / lawyer | ☐ |
| **Tax** | | | | |
| 5 | **TIN** (Tax Identification Number) | Register the company with the tax authority (FIRS / JTB single TIN system) and the relevant state revenue service. | Accountant | ☐ |
| 6 | **VAT registration and charging** | Check whether our platform fees and commissions are VATable (7.5% standard rate historically) and whether VAT registration is mandatory at our turnover; decide whether barber-facing fees are VAT-inclusive; issue compliant invoices/receipts to barbers. | Accountant | ☐ |
| 7 | Income / company tax, withholding tax, development levy | Confirm obligations under the current law, including the 2025 tax reform Acts (Nigeria Tax Act and Tax Administration Act, in effect from 2026 — verify status and rules for small companies and digital platforms). | Accountant | ☐ |
| 8 | Barber tax responsibility | Confirm whether the platform has any duty to collect, withhold or report on barbers' earnings; if so, build it in. Until decided, the Barber Agreement says barbers are responsible for their own tax. | Accountant / lawyer | ☐ |
| 9 | Bookkeeping | Keep payment, refund, fee and commission records (financial records are not hard-deletable in the app). Reconcile with Paystack monthly. | Accountant | ☐ |
| **Data protection** | | | | |
| 10 | **NDPC registration** | Under the NDPA 2023 and the NDPC's General Application and Implementation Directive (GAID 2025), check whether TrimSlot is a **"data controller/processor of major importance"** that must register with the Nigeria Data Protection Commission, and at what thresholds; register if so, and keep the registration number in the Privacy Policy. | Lawyer | ☐ |
| 11 | **Data Protection Officer** | Appoint a DPO (internal or outsourced) if required; publish contact. | Owner | ☐ |
| 12 | Data audit / compliance returns | Annual compliance audit return to the NDPC if applicable; keep a record of processing activities. | DPO | ☐ |
| 13 | **DPIA** | Do a data protection impact assessment for the reliability label, reviews/reports and push notifications. | DPO | ☐ |
| 14 | Processor contracts | Data processing agreements with Supabase, Vercel, Paystack and Resend (e-mail provider, only if e-mail verification is on); transfer mechanism for data leaving Nigeria (UK/EU/US); list sub-processors. | Lawyer | ☐ |
| 15 | Breach procedure | 72-hour NDPC notification plan; named incident owner; contact list. | DPO | ☐ |
| 16 | Data-subject requests | Process for access / correction / deletion / export. Self-service JSON export and account deletion are built (Profile); decide timeline and logging for requests that arrive by e-mail, and for barber deletion requests (an admin alert is raised). | DPO | ☐ |
| 17 | Retention schedule | Approve the retention periods in the Privacy Policy. Automatic clean-up is built (it runs from the scheduled sweep, at most hourly, but the sweep itself runs daily unless the external one-minute timer is on — see item 35) and the periods are admin settings; check the defaults match what you approve. | DPO + dev | ☐ |
| **Payments** | | | | |
| 18 | **Paystack business verification (live mode)** | Complete Paystack's business verification (CAC documents, directors' ID, bank account, business description, website with Terms/Privacy/refund policy). Switch from test to live keys only after approval. Keep the webhook URL and secret set. | Owner | ☐ |
| 19 | Paystack subaccount / split terms | Confirm Paystack allows our marketplace split model (subaccount, bearer = account, transaction charge); that the three-way fee split (customer booking fee, barber share, TrimSlot share) matches what Paystack really charges; settlement schedule; **what happens on refunds and chargebacks of a split payment, and who bears them (the app has no feature that takes them from a barber's balance)**; whether each barber must complete KYC. | Owner / Paystack | ☐ |
| 20 | **CBN / payments regulation** | Confirm with the lawyer that, because Paystack (a licensed payment company) collects and settles the money and we never hold customer funds, TrimSlot needs no CBN licence. Do not change the payment flow without re-checking. | Lawyer | ☐ |
| 21 | AML / fraud | Basic policy for suspicious activity; ability to suspend shops; record of who approved each shop. | Owner | ☐ |
| **Consumers** | | | | |
| 22 | **Consumer protection (FCCPA 2018 / FCCPC)** | Review Terms and refund rules against the Federal Competition and Consumer Protection Act 2018 and FCCPC regulations (including any rules for digital / online platforms and for complaint handling). In particular: fair terms, clear pricing, refund rights for prepaid services, cooling-off, complaint process. Check if business registration with the FCCPC or a local representative is needed. | Lawyer | ☐ |
| 23 | Complaint handling | Publish contact, response times, escalation; keep a log of complaints. | Owner | ☐ |
| 24 | Price transparency | Show the customer's **booking fee** (their share of the payment-processor fee) as its own line, with the total, before payment — built. Confirm the wording, and that no fixed Paystack rates are quoted anywhere (they change). Show the fee split to barbers (built: their bookings and earnings). | Dev / owner | ☐ |
| 25 | Cancel/refund wording in the app | Make the cancellation cut-off, the refund (pending approval, auto-approved) and credit rules visible on the booking and payment screens. Built: the booking shows "refund pending / refunded"; confirm the wording. | Dev | ☐ |
| **Barber side** | | | | |
| 26 | Barber onboarding checks | Decide ID / business proof / address verification for approving shops. | Owner | ☐ |
| 27 | Hygiene and local permits | List state/local rules for barber shops (health permits, signage, levies) in launch states and add to the onboarding checklist. | Lawyer | ☐ |
| 28 | Agreement acceptance | Mandatory tick-boxes (customers: Terms and Privacy; barbers: also the Barber Agreement) with a log of document, version, date, IP and user agent, and a re-accept prompt when a version changes. **Built**; confirm the wording and set the real document versions in admin Controls once the lawyer has approved the texts. | Dev | ☐ |
| **Insurance** | | | | |
| 29 | Platform insurance | Consider public liability, professional indemnity and cyber/data-breach cover for TrimSlot. | Owner / broker | ☐ |
| 30 | Barber insurance | Decide whether public-liability cover is **required** or only **recommended** for barbers (and minimum cover). | Owner / lawyer | ☐ |
| **Operations and launch** | | | | |
| 31 | Support contacts live | Working support e-mail and phone; replace all placeholders in documents and in the app footer. | Owner | ☐ |
| 32 | Backups and continuity | Database backup plan (free hosting tiers may have no backups) and a tested restore. | Dev | ☐ |
| 33 | Terms acceptance records | Keep which version each user accepted. | Dev | ☐ |
| 34 | Remove draft banners | Only after the lawyer approves and all placeholders are filled. | Owner | ☐ |
| 35 | Sweeper timer | The scheduled sweep (reminders, auto-approving refunds, closing abandoned tries, ledger reminders, retention clean-up) runs **once a day** on Vercel by default (`0 3 * * *`). For minute-level behaviour set up the external one-minute timer (DEPLOY.md section 7) and tick this when it is running. | Owner / dev | ☐ |

## Open questions for the lawyer

> Numbers refer to `00-open-questions-for-lawyer.md`, which has the full list.

* **Q1.** Which entity and structure; who signs?
* **Q4.** Launch states and any state or local rules.
* **Q41.** FCCPC requirements for online platforms.
* **Q42.** Consumer notices required before payment.
* **Q43.** What will Paystack ask for at live onboarding?
* **Q44.** Platform insurance (professional indemnity, cyber).
* **Q45.** Acceptable Use / Complaints / Community Guidelines page needed?
