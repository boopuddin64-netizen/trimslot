/** One design for every TrimSlot email. Values are escaped; the text version is always included. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

export interface EmailParts {
  eyebrow: string;        // small caps label above the title, e.g. "SECURITY VERIFICATION"
  title: string;          // main heading
  intro: string;          // one sentence under the heading
  code?: string;          // optional one-time code shown in a box
  expiry?: string;        // bold line under the code, e.g. "This code expires in 10 minutes."
  note: string;           // closing line, e.g. "If you did not request this, you can ignore this email."
}

export function renderEmail(p: EmailParts): { text: string; html: string } {
  const text = [p.title, '', p.intro, p.code ? `\nYour code: ${p.code}` : '', p.expiry ?? '', '', p.note, '', 'TrimSlot · https://trimslot.com.ng']
    .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim() + '\n';
  const codeBlock = p.code ? `<div style="background:#f1f6ff;border:1px solid #d8e6ff;border-radius:12px;padding:20px;text-align:center;margin:0 0 6px">
<div style="font-size:34px;line-height:1.3;font-weight:700;letter-spacing:9px;color:#2459c5">${esc(p.code)}</div></div>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:28px 12px;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#17243b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5eaf2;border-radius:18px;overflow:hidden">
<tr><td style="background:#0b1730;padding:26px 30px;text-align:center">
<a href="https://trimslot.com.ng" style="text-decoration:none;color:#fff">
<img src="https://trimslot.com.ng/icons/apple-touch-icon.png" width="48" height="48" alt="TrimSlot" style="display:block;width:48px;height:48px;margin:0 auto 12px;border:0">
<span style="font-size:23px;font-weight:700;letter-spacing:.2px;color:#fff">Trim<span style="color:#66a5ff">Slot</span></span>
</a></td></tr>
<tr><td style="padding:34px 30px 30px">
<p style="margin:0 0 8px;color:#55708f;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">${esc(p.eyebrow)}</p>
<h1 style="margin:0 0 12px;font-size:25px;line-height:1.25;color:#14213a">${esc(p.title)}</h1>
<p style="margin:0 0 22px;color:#526178;font-size:15px;line-height:1.6">${esc(p.intro)}</p>
${codeBlock}
${p.expiry ? `<p style="margin:20px 0 0;color:#33445d;font-size:14px;line-height:1.6"><strong>${esc(p.expiry)}</strong> Do not share it with anyone, including TrimSlot staff.</p>` : ''}
<p style="margin:18px 0 0;color:#718096;font-size:13px;line-height:1.6">${esc(p.note)}</p>
</td></tr>
<tr><td style="padding:18px 30px;background:#f7f9fc;border-top:1px solid #e8edf4;text-align:center;color:#7b8798;font-size:12px;line-height:1.6">© TrimSlot · <a href="https://trimslot.com.ng" style="color:#315fc4;text-decoration:none">trimslot.com.ng</a><br>Appointment booking, made simple.</td></tr>
</table></body></html>`;
  return { text, html };
}
