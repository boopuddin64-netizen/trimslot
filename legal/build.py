#!/usr/bin/env python3
"""Build legal/legal-pack.docx (via LibreOffice) and the in-app legal pages from the Markdown.
Usage: legal/build.sh   (needs python 'markdown' and soffice)"""
import re, subprocess, pathlib, shutil, tempfile, html as H
import markdown

ROOT = pathlib.Path(__file__).resolve().parent
PUB = ROOT.parent / "public"
# Only the two EXISTING in-app pages are generated (scope decision: no new app pages, no CSS/JS changes).
PAGES = {  # md file -> (public page, <title>)
    "01-terms-of-service.md": ("terms.html", "Terms of Service"),
    "03-privacy-policy.md": ("privacy.html", "Privacy Policy"),
}
DOCS = ["00-open-questions-for-lawyer.md", "01-terms-of-service.md", "02-barber-agreement.md", "03-privacy-policy.md",
        "04-refund-cancellation-credit-policy.md", "05-plan-subscription-terms.md", "06-cookie-and-notification-consent.md",
        "07-compliance-checklist.md", "08-app-behaviour-reference.md"]
LIVE = {"terms.html", "privacy.html"}
INLINE_CSS = ('<style>.legal mark.ph{background:var(--accent-soft);color:var(--accent-ink);padding:0 3px;border-radius:3px;font-weight:600}'
  '.legal .tblwrap{overflow-x:auto;margin:12px 0}.legal table{border-collapse:collapse;font-size:13px;min-width:520px}'
  '.legal th,.legal td{border:1px solid var(--ctl);padding:6px 8px;text-align:left;vertical-align:top}.legal th{background:var(--bg2);color:var(--ink)}'
  '.legal blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--ctl)}.legal code{overflow-wrap:anywhere}.legal li{margin:4px 0}</style>')

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

def web_page(md_name, page, title):
    body = md2html(strip_first_quote((ROOT / md_name).read_text(encoding="utf-8")).split("\n## Open questions for the lawyer")[0])
    body = unlink_unpublished(mark_placeholders(body))
    body = re.sub(r"<table>", '<div class="tblwrap"><table>', body).replace("</table>", "</table></div>")
    body = re.sub(r"<h1>.*?</h1>", lambda m: m.group(0) + BANNER, body, count=1, flags=re.S)
    foot = '<footer class="foot"><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></footer>'
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>{H.escape(title)} — TrimSlot</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script>{INLINE_CSS}</head>
<body><header class="topbar"><a class="brand" href="/"><span class="logo"><svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg></span>Trim<b>Slot</b></a><a href="/" class="toplink">← Back to app</a></header>
<div class="legal">
{body}
</div>
{foot}</body></html>
'''

def docx():
    parts = ['<h1 style="page-break-before:avoid">TrimSlot legal pack — DRAFT</h1><p><b>DRAFT – not legal advice – lawyer review required.</b> Generated from the Markdown files in /legal. Placeholders in [SQUARE BRACKETS] are undecided.</p>']
    for n, name in enumerate(DOCS):
        h = md2html((ROOT / name).read_text(encoding="utf-8"))
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
