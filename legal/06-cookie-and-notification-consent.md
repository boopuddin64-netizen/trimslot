# Cookie, Device Storage and Notification Notice

> **DRAFT – not legal advice – lawyer review required.** Replace every `[BRACKETED]` item. See `00-open-questions-for-lawyer.md`.

<div class="plain-summary">
<p class="ps-title"><b>In plain words</b></p>
<ul>
<li>We use no advert, tracking or analytics cookies.</li>
<li>One cookie keeps you logged in. It lasts 7 days, or until you log out.</li>
<li>Your browser also saves small settings, like dark mode and your alert choices.</li>
<li>Alerts in the app (the bell) are part of the service. They are never adverts.</li>
<li>Phone or computer alerts (push) need your permission. You can turn them off in Profile.</li>
<li>On an iPhone, push alerts work only after you add TrimSlot to your Home Screen.</li>
</ul>
<p class="ps-note">This is a short summary. The full text below is what counts.</p>
</div>

**Effective date:** [EFFECTIVE DATE]  **Version:** [VERSION]

## Part A — Cookies and similar storage (long form, for the website)

TrimSlot keeps this to the minimum. We **do not use advertising, tracking or analytics cookies**, and we do not use third-party tracking scripts.

| Name | Type | What it is for | How long | Needs consent? |
|---|---|---|---|---|
| `trimslot_token` | Cookie (first-party, **HttpOnly**, SameSite=Lax, Secure) | Keeps you logged in | **7 days**, or until you log out | No — strictly necessary for a service you asked for |
| `trimslot_theme` | Browser local storage | Remembers light/dark mode | Until cleared | No — a user-interface preference you choose |
| `trimslot_alerts`, `trimslot_push` | Browser local storage | Remembers your notification choices (sound/alerts on or off; whether push is on) | Until cleared | No — it stores a choice you made |
| `trimslot_prompt_snooze` | Browser local storage | Remembers that you said "not now" to the notification prompt, so we don't nag | Until cleared | No |
| `trimslot_next` | Browser session storage | Remembers the page you were going to open when you were asked to log in | Until you close the tab | No |
| Service worker and cache | Browser | Lets the app receive notifications and load faster | Until cleared | Notifications: yes (see Part B) |
| Admin key (staff only) | Browser session storage | Keeps staff signed in to the admin area | Until you close the tab | No |
| Profile picture | Served by the app to you and your barbers only; not a cookie | Shows your optional photo | Until you remove it or delete your account | Your choice (you upload it) |

Our payment provider **Paystack** and our host **Vercel** may set their own cookies or collect technical data when you use their pages (for example, the Paystack checkout page). Their notices apply: [PAYSTACK PRIVACY LINK], [VERCEL PRIVACY LINK]. 

You can delete cookies and site data in your browser settings; you will then be logged out and your settings reset.

[LAWYER: confirm that strictly-necessary storage does not require consent banners under the NDPA/GAID and Nigerian practice, and that no banner is needed while we use no non-essential cookies. If analytics are added later, a consent banner is needed.]

## Part B — Notifications

TrimSlot sends two kinds of notification:

1. **In-app notifications** (the bell icon). These are part of the service — booking confirmations, payment results, reminders, queue position, refunds and credits, and messages from your barber or from us. They are always stored for you. They cannot be switched off, but they are never marketing.
2. **Browser (push) notifications** on your phone or computer, which alert you even when the app is closed. These need **your permission**.

### Consent text shown in the app (before the browser's own permission box)

> **Turn on notifications?**
> Get a message on this device when your booking is confirmed, when it's almost time, when it's your turn in the queue, and about refunds or credits. We send **no adverts**. You can turn this off any time in Profile → Notifications, or in your browser settings.
> By tapping **Turn on**, you agree that TrimSlot stores a push subscription for this device (a technical address and keys created by your browser) and uses your browser's push service (for example Google, Mozilla or Apple) to deliver these messages. See our [Privacy Policy](privacy.html).
> **[Turn on]**  **[Not now]**

### Details

* **What we store:** the subscription address and encryption keys your browser gives us, linked to your account, plus which messages were sent. We do not read your contacts or location.
* **What the messages contain:** booking details such as shop name, service and time. These may appear on your lock screen — turn off lock-screen previews on your device if that matters.
* **Withdrawing consent:** turn off "Push notifications" in Profile → Notifications (we then delete the subscription), or block notifications for the site in your browser. This does not affect the in-app list.
* **Staff** can turn on push alerts for refunds waiting, auto-approved refunds, refund failures and deletion requests (with quiet hours); they are separate from customer notifications.
* **Barbers** receive notifications about new bookings, arrivals, cancellations and balance reminders.
* **Marketing:** none today. If we ever send marketing, we will ask for a separate consent and you will be able to say no without losing the service.
* **Legal basis:** consent (for push); contract (for in-app service messages).
* **iPhone / iPad:** web push only works after you add TrimSlot to your Home Screen.

## Open questions for the lawyer

> Numbers refer to `00-open-questions-for-lawyer.md`, which has the full list.

* **Q39.** Is a cookie banner needed with one strictly necessary cookie plus local-storage preferences?
* **Q40.** Is the push-notification consent text sufficient? Rules on lock-screen messages?
