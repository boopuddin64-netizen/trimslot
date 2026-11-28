/** One design for every TrimSlot email, matching the app's loading screen (light page, brand blue, wordmark).
 *  Values are escaped. Every email also gets a plain-text version. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

const BRAND = '#3358d4';
const INK = '#0f172a';
const MUTED = '#64748b';
const LOGO_URL = 'https://trimslot.com.ng/icons/email-logo.png';   // the loading-screen logo, hosted on the site

export interface EmailParts {
  eyebrow: string;                 // small label above the title, e.g. "BOOKING CONFIRMED"
  title: string;                   // main heading
  intro: string;                   // one sentence under the heading
  code?: string;                   // optional one-time code in a box
  rows?: Array<[string, string]>;  // optional details table, e.g. [["Service", "Haircut"], ["Total paid", "₦301.62"]]
  expiry?: string;                 // bold line under the code, e.g. "This code expires in 10 minutes."
  note: string;                    // closing line
}

export function renderEmail(p: EmailParts): { text: string; html: string } {
  const rowsText = (p.rows ?? []).map(([k, v]) => `${k}: ${v}`);
  const text = [p.title, '', p.intro, p.code ? `\nYour code: ${p.code}` : '', ...(rowsText.length ? ['', ...rowsText] : []), p.expiry ? `\n${p.expiry}` : '', '', p.note, '', '— TrimSlot · https://trimslot.com.ng']
    .join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const codeBlock = p.code ? `<div style="background:#eef3ff;border:1px solid #d6e2ff;border-radius:14px;padding:20px;text-align:center;margin:0">
<div style="font-size:34px;line-height:1.3;font-weight:700;letter-spacing:9px;color:${BRAND}">${esc(p.code)}</div></div>` : '';

  const rowsBlock = p.rows?.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0;border-top:1px solid #e6ebf3">${p.rows.map(([k, v]) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #e6ebf3;color:${MUTED};font-size:14px">${esc(k)}</td><td align="right" style="padding:12px 0;border-bottom:1px solid #e6ebf3;color:${INK};font-size:14px;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>` : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:32px 14px;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto">
<tr><td align="center" style="padding:0 0 22px">
<a href="https://trimslot.com.ng" style="text-decoration:none;color:${INK};font-size:24px;font-weight:700;letter-spacing:-.3px">
<img src="${LOGO_URL}" width="48" height="48" alt="TrimSlot" style="display:inline-block;vertical-align:middle;width:48px;height:48px;border:0;margin-right:10px"><span style="vertical-align:middle">Trim<span style="color:${BRAND}">Slot</span></span>
</a></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e6ebf3;border-radius:18px;padding:32px 30px">
<p style="margin:0 0 8px;color:${BRAND};font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase">${esc(p.eyebrow)}</p>
<h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;color:${INK}">${esc(p.title)}</h1>
<p style="margin:0 0 22px;color:${MUTED};font-size:15px;line-height:1.6">${esc(p.intro)}</p>
${codeBlock}
${rowsBlock}
${p.expiry ? `<p style="margin:20px 0 0;color:${INK};font-size:14px;line-height:1.6"><strong>${esc(p.expiry)}</strong> Do not share it with anyone, including TrimSlot staff.</p>` : ''}
<p style="margin:22px 0 0;color:${MUTED};font-size:13px;line-height:1.6">${esc(p.note)}</p>
</td></tr>
<tr><td align="center" style="padding:20px 10px 0;color:${MUTED};font-size:12px;line-height:1.6">© TrimSlot · <a href="https://trimslot.com.ng" style="color:${BRAND};text-decoration:none">trimslot.com.ng</a><br>Appointment booking, made simple.</td></tr>
</table></body></html>`;
  return { text, html };
}
