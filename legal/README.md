# TrimSlot legal pack — DRAFT

> **DRAFT – not legal advice – lawyer review required.**
> Written by the product team, in plain English, for review by a qualified Nigerian lawyer. Nothing here has been approved by counsel or by TrimSlot's owner.

## What is in this folder

| File | What it is |
|---|---|
| `00-open-questions-for-lawyer.md` | The questions we could not answer ourselves. **Start here.** |
| `01-terms-of-service.md` | Terms of Service for customers (and everyone using the app) |
| `02-barber-agreement.md` | Barber Agreement (independent business, fees, payouts, suspension) |
| `03-privacy-policy.md` | Privacy Policy under the Nigeria Data Protection Act 2023 (NDPA) |
| `04-refund-cancellation-credit-policy.md` | Refund, Cancellation and Credit Policy (matches what the app really does) |
| `05-plan-subscription-terms.md` | Plan (session pack) Terms |
| `06-cookie-and-notification-consent.md` | Cookie / device-storage notice and notification (push) consent text |
| `07-compliance-checklist.md` | Short checklist: CAC, TIN, VAT, NDPC, Paystack verification, consumer protection, insurance |
| `08-app-behaviour-reference.md` | Table of what the app actually does, with the source file for each rule (for the lawyer to check the documents against the product) |
| `legal-pack.docx`, `legal-pack.pdf` | All of the above combined in one Word file / one PDF (for the lawyer) |
| `build.sh` | Rebuilds `legal-pack.docx`, `legal-pack.pdf` and the two in-app pages that already existed (`public/terms.html`, `public/privacy.html`) from the Markdown. The other documents are **not yet published as app pages** (deliberately: no new app pages/CSS until the lawyer has reviewed); in the app pages links to them appear as plain text. |

## Conventions

* `[SQUARE BRACKETS IN CAPITALS]` = something we do not know yet (company name, address, e-mail…). Replace before launch.
* `[LAWYER: …]` = a specific point where we need a decision or a check.
* Numbers such as "30 minutes", "30 days", "₦10 + 0.15 %" are what the app does **today**. Several are admin settings and can change; the documents say so where it matters. If the business decides to change a number, change the document too.
* The app is in **Paystack test mode** and **maintenance mode** (bookings paused) while this pack is reviewed. These documents describe the intended live service.
* Money amounts are in Nigerian Naira (₦). Times are West Africa Time (Lagos, UTC+1).

## How the documents fit together

1. Everyone accepts the **Terms of Service** and is told about the **Privacy Policy** when creating an account.
2. Barbers additionally accept the **Barber Agreement** when they sign up (the app needs a checkbox for this — see open questions).
3. The **Refund, Cancellation and Credit Policy** and the **Plan Terms** are incorporated into the Terms of Service (they are linked from it and shown at the point of booking / purchase).
4. The **Cookie and Notification text** is shown in the app the first time notifications are offered.
