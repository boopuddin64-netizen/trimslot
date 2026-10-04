#!/usr/bin/env python3
"""Self-test for the public-page guard in build.py: each bad snippet must be refused, and clean text must pass. Run: python3 legal/test_guard.py"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build

BAD = [
    "<p>Your payout = price − the Paystack fee</p>", "<p>We use a Paystack subaccount.</p>", "<p>Payments are split three ways.</p>",
    "<p>TrimSlot keeps or covers the difference.</p>", "<p>The barber pays the processing fee.</p>", "<p>Reminders when the balance is more than 7 days old.</p>",
    "<p>Plans cost ₦1,000 to ₦500,000, up to 90 days.</p>", "<p>Every 10 visits earns a credit.</p>", "<p>We approve it within 3 hours.</p>",
    "<p>[PROPOSED: refunds in 5 days]</p>", "<p>[LAWYER: check this]</p>", "<p>Gap found in review: the card is short.</p>", "<p>Version: [VERSION]</p>",
    "<p>[Provider backups: CHECK plan]</p>", "<p>{{terms_version}}</p>", "<ul><li>* a list that did not render</li></ul>", "<p>* item</p>",
]
GOOD = ["<p>Fees and your payout are shown in the app before you accept.</p>", "<p>[COMPANY NAME] [EMAIL] [30]</p>", "<p>Marketing: none today.</p>", "<p>We tell the NDPC within 72 hours.</p>"]
bad_missed = []
for b in BAD:
    try: build.check_public("x.html", b); bad_missed.append(b)
    except SystemExit: pass
good_failed = []
for g in GOOD:
    try: build.check_public("x.html", g)
    except SystemExit as e: good_failed.append((g, str(e)[:80]))
if bad_missed or good_failed:
    print("guard self-test FAILED. not refused:", bad_missed, "wrongly refused:", good_failed); sys.exit(1)
print("guard self-test ok: %d bad snippets refused, %d clean ones allowed" % (len(BAD), len(GOOD)))
