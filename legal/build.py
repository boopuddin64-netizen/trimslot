#!/usr/bin/env python3
"""Build legal/legal-pack.docx/.pdf (via LibreOffice) and the six public legal pages from the Markdown.
Usage: legal/build.sh   (needs python 'markdown' and soffice)"""
import re, subprocess, pathlib, shutil, tempfile, html as H
import markdown

ROOT = pathlib.Path(__file__).resolve().parent
PUB = ROOT.parent / "public"
PAGES = {  # md file -> (public page, <title>)
    "01-terms-of-service.md": ("terms.html", "Terms of Service"),
    "03-privacy-policy.md": ("privacy.html", "Privacy Policy"),
    "04-refund-cancellation-credit-policy.md": ("refunds.html", "Refund, Cancellation and Credit Policy"),
    "05-plan-subscription-terms.md": ("plan-terms.html", "Plan Terms"),
    "06-cookie-and-notification-consent.md": ("cookies.html", "Cookie and Notification Notice"),
    "02-barber-agreement.md": ("barber-agreement.html", "Barber Agreement"),
}
# Built-in defaults = the platform defaults. {{key}} in the Markdown is a live number on the web pages (public/legal-live.js
# fills <span data-s="key"> from /api/public-settings) and this default in the Word/PDF files.
DEFAULTS = {
    "cancel_cutoff_min": "30", "payment_hold_min": "15", "credit_expiry_days": "30", "refund_auto_approve_hours": "3",
    "platform_charge_percent": "2", "platform_charge_flat_naira": "0", "platform_charge_min_naira": "50",
    "fee_share_customer_percent": "33.333", "fee_share_barber_percent": "33.333", "fee_share_platform_percent": "33.334",
    "ps_percent": "1.5", "ps_flat_naira": "100", "ps_flat_waived_below_naira": "2,500", "ps_cap_naira": "2,000", "ps_vat_percent": "7.5",
    "commission_percent": "50", "min_barber_payout_percent": "50",
    "min_plan_price_naira": "1,000", "max_plan_price_naira": "500,000", "max_plan_validity_days": "90", "max_plan_sessions": "30",
    "liability_cap_naira": "₦[AMOUNT]",
    "retention_events_days": "400", "retention_bad_events_days": "30", "retention_notifications_days": "180", "retention_push_stale_days": "60",
    "retention_deleted_days": "30", "loyalty_every_n": "10", "loyalty_credit_naira": "1,000", "retention_checkout_days": "2", "retention_rate_limit_hours": "2", "retention_admin_alerts_days": "90",
    "terms_version": "1", "privacy_version": "1", "barber_agreement_version": "1",
}
# The public pages may quote only these numbers (they are what /api/public-settings serves). Fee, charge, split, commission and refund-timing numbers are business settings:
# they may appear in the internal lawyer files only (00, 07, 08 and the pack), never on a public page.
PUBLIC_TOKENS = {"cancel_cutoff_min", "payment_hold_min", "credit_expiry_days", "min_plan_price_naira", "max_plan_price_naira", "max_plan_validity_days", "max_plan_sessions",
    "liability_cap_naira", "retention_events_days", "retention_bad_events_days", "retention_notifications_days", "retention_push_stale_days", "retention_deleted_days",
    "retention_checkout_days", "retention_rate_limit_hours", "retention_admin_alerts_days", "loyalty_every_n", "loyalty_credit_naira", "terms_version", "privacy_version", "barber_agreement_version"}
TOKEN = re.compile(r"\{\{([a-z_]+)\}\}")

def fill_tokens(text, live):
    def one(m):
        k = m.group(1)
        if k not in DEFAULTS: raise SystemExit("unknown setting token {{%s}}" % k)
        if live and k not in PUBLIC_TOKENS: raise SystemExit("{{%s}} is an internal business number and must not appear on a public page" % k)
        return '<span data-s="%s">%s</span>' % (k, H.escape(DEFAULTS[k])) if live else DEFAULTS[k]
    return TOKEN.sub(one, text)
DOCS = ["00-open-questions-for-lawyer.md", "01-terms-of-service.md", "02-barber-agreement.md", "03-privacy-policy.md",
        "04-refund-cancellation-credit-policy.md", "05-plan-subscription-terms.md", "06-cookie-and-notification-consent.md",
        "07-compliance-checklist.md", "08-app-behaviour-reference.md"]
LIVE = {page for page, _ in PAGES.values()}
INLINE_CSS = ('<style>.legal mark.ph{background:var(--accent-soft);color:var(--accent-ink);padding:0 3px;border-radius:3px;font-weight:600}'
  '.legal .tblwrap{overflow-x:auto;margin:12px 0}.legal table{border-collapse:collapse;font-size:13px;min-width:520px}'
  '.legal th,.legal td{border:1px solid var(--ctl);padding:6px 8px;text-align:left;vertical-align:top}.legal th{background:var(--bg2);color:var(--ink)}'
  '.legal blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--ctl)}.legal code{overflow-wrap:anywhere}.legal li{margin:4px 0}'
  '.legal .plain-summary{background:var(--accent-soft);color:var(--accent-ink);border:1px solid var(--ctl);border-left:4px solid var(--accent);border-radius:10px;padding:12px 16px;margin:16px 0}'
  '.legal .plain-summary p{margin:0 0 6px}.legal .plain-summary .ps-title{font-size:16px}.legal .plain-summary ul{margin:6px 0;padding-left:20px}'
  '.legal .plain-summary li{margin:6px 0;font-size:15px}.legal .plain-summary .ps-note{font-size:13px;margin:8px 0 0}</style>')

def unlink_unpublished(h):
    # links to documents that are not (yet) published as app pages become plain text
    return re.sub(r'<a href="(?!https?:|mailto:|#)([^"]*)">(.*?)</a>',
                  lambda m: m.group(0) if m.group(1).split("#")[0] in LIVE else m.group(2), h, flags=re.S)
BANNER = ('<div class="draft"><b>DRAFT – not legal advice – lawyer review required.</b> '
          'This page is a draft prepared for review by a qualified Nigerian lawyer. Items in '
          '<mark class="ph">[SQUARE BRACKETS]</mark> are not decided yet. Do not rely on it until it has been reviewed and completed.</div>')
PH = re.compile(r"\[(?:[A-Z][A-Z0-9 _/.\-]{1,60}|LAWYER:[^\]]*|OWNER:[^\]]*|\d+)\]")

def md2html(text):
    return markdown.markdown(text, extensions=["tables", "sane_lists", "fenced_code"])

def mark_placeholders(h):
    parts = re.split(r"(<[^>]+>)", h)
    out, skip = [], 0
    for p in parts:
        if p.startswith("<"):
            if re.match(r"<(code|pre|a)\b", p): skip += 1
            elif re.match(r"</(code|pre|a)>", p): skip = max(0, skip - 1)
            out.append(p)
        else:
            out.append(p if skip else PH.sub(lambda m: '<mark class="ph">%s</mark>' % m.group(0), p))
    return "".join(out)

def strip_first_quote(text):
    # drop the leading "> **DRAFT ..." block (the page shows its own banner)
    lines = text.split("\n")
    i = next((k for k, l in enumerate(lines) if l.startswith(">")), None)
    if i is None or i > 3: return text
    j = i
    while j < len(lines) and lines[j].startswith(">"): j += 1
    return "\n".join(lines[:i] + lines[j:])

NOTE = re.compile(r"\s*\[(?:LAWYER|OWNER)[^\]]*\]")   # drafting notes for the owner/lawyer stay in the pack and never reach a public page

def web_page(md_name, page, title):
    body = md2html(NOTE.sub("", strip_first_quote((ROOT / md_name).read_text(encoding="utf-8")).split("\n## Open questions for the lawyer")[0]))
    body = unlink_unpublished(mark_placeholders(fill_tokens(body, True)))
    body = re.sub(r"<table>", '<div class="tblwrap"><table>', body).replace("</table>", "</table></div>")
    body = re.sub(r"<h1>.*?</h1>", lambda m: m.group(0) + BANNER, body, count=1, flags=re.S)
    foot = ('<footer class="foot"><a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a> · <a href="/refunds.html">Refunds</a> · '
            '<a href="/plan-terms.html">Plan terms</a> · <a href="/cookies.html">Cookies</a> · <a href="/barber-agreement.html">Barber agreement</a></footer>')
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>{H.escape(title)} — TrimSlot</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script>{INLINE_CSS}<script src="/legal-live.js" defer></script></head>
<body><header class="topbar"><a class="brand" href="/"><span class="logo"><svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg></span>Trim<b>Slot</b></a><a href="/" class="toplink">← Back to app</a></header>
<div class="legal">
{body}
</div>
{foot}</body></html>
'''

def docx():
    parts = ['<h1 style="page-break-before:avoid">TrimSlot legal pack — DRAFT</h1><p><b>INTERNAL – FOR THE OWNER AND THE LAWYER ONLY. DO NOT PUBLISH.</b> This pack contains business details (fees, charges, internal settings) that must not appear on any public page.</p><p><b>DRAFT – not legal advice – lawyer review required.</b> Generated from the Markdown files in /legal. Placeholders in [SQUARE BRACKETS] are undecided.</p>']
    for n, name in enumerate(DOCS):
        h = md2html(fill_tokens((ROOT / name).read_text(encoding="utf-8"), False))
        h = re.sub(r"<a href=\"[^\"]*\.(?:html|md)\">(.*?)</a>", r"\1", h)  # in-pack links are meaningless in Word
        h = re.sub(r"<table>", '<table border="1" cellpadding="4" cellspacing="0" width="100%">', h)
        parts.append('<div style="page-break-before:always"></div>' + h)
    doc = '<!doctype html><html><head><meta charset="utf-8"><title>TrimSlot legal pack</title><style>body{font-family:Calibri,Arial;font-size:11pt}th{background:#e8e8e8}</style></head><body>' + "\n".join(parts) + "</body></html>"
    with tempfile.TemporaryDirectory() as t:
        src = pathlib.Path(t) / "legal-pack.html"
        src.write_text(doc, encoding="utf-8")
        subprocess.run(["soffice", "--headless", "--infilter=HTML (StarWriter)", "--convert-to", "docx:MS Word 2007 XML",
                        "--outdir", t, str(src)], check=True, capture_output=True, timeout=240)
        shutil.copy(pathlib.Path(t) / "legal-pack.docx", ROOT / "legal-pack.docx")
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", t, str(pathlib.Path(t) / "legal-pack.docx")],
                       check=True, capture_output=True, timeout=240)
        shutil.copy(pathlib.Path(t) / "legal-pack.pdf", ROOT / "legal-pack.pdf")

if __name__ == "__main__":
    for md, (page, title) in PAGES.items():
        (PUB / page).write_text(web_page(md, page, title), encoding="utf-8")
        print("wrote public/" + page)
    docx()
    print("wrote legal/legal-pack.docx and legal-pack.pdf")
