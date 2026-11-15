import QRCode from 'qrcode';

type Receipt = {
  type: 'BOOKING' | 'PLAN'; receipt_number: string; amount_kobo: number; status: string; paid_at: string;
  item?: string | null; service?: string | null; barber?: string | null; shop?: string | null; location?: string | null;
  customer_name?: string | null; customer_email?: string | null; customer_phone?: string | null;
  payment_provider?: string | null; reference?: string | null; appointment_date?: string | null; appointment_time?: string | null;
  sessions_total?: number | null; validity_days?: number | null; expires_at?: string | null;
};
const PAGE_W = 420, PAGE_H = 595;
const clean = (value: unknown) => Array.from(String(value ?? '—').replace('₦', 'NGN ')).map(ch => { const n = ch.charCodeAt(0); return n >= 32 && n <= 126 ? ch : '?'; }).join('');
const pdfText = (value: unknown) => clean(value).split(String.fromCharCode(92)).join(String.fromCharCode(92, 92)).split('(').join(String.fromCharCode(92) + '(').split(')').join(String.fromCharCode(92) + ')');
const money = (kobo: number) => 'NGN ' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dependency-free A5 PDF renderer. QR modules are native vector squares. */
export async function buildReceiptPdf(receipt: Receipt, verificationUrl: string): Promise<Buffer> {
  const commands: string[] = [];
  const y = (top: number) => PAGE_H - top;
  const text = (value: unknown, x: number, top: number, size = 9, bold = false, color = '0.09 0.15 0.25') =>
    commands.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y(top)} Tm (${pdfText(value)}) Tj ET`);
  const rect = (x: number, top: number, w: number, h: number, fill: string, stroke?: string) =>
    commands.push(`${fill} rg ${stroke ? stroke + ' RG 0.8 w ' : ''}${x} ${PAGE_H - top - h} ${w} ${h} re ${stroke ? 'B' : 'f'}`);
  const line = (x1: number, top: number, x2: number) => commands.push(`0.86 0.89 0.93 RG 0.7 w ${x1} ${y(top)} m ${x2} ${y(top)} l S`);
  const label = (value: string, x: number, top: number) => text(value.toUpperCase(), x, top, 7, true, '0.29 0.40 0.58');
  const row = (name: string, value: unknown, top: number) => {
    const v = clean(value), size = v.length > 44 ? 7 : v.length > 30 ? 7.5 : 8.5;
    text(name, 38, top, 8, false, '0.39 0.46 0.56');
    text(v, Math.max(205, 382 - Math.min(v.length, 42) * size * 0.48), top, size, true);
    line(38, top + 6, 382);
  };
  rect(0, 0, PAGE_W, PAGE_H, '1 1 1');
  rect(0, 0, PAGE_W, 156, '0.03 0.08 0.17');
  rect(26, 24, 36, 36, '0.25 0.40 0.86');
  text('TS', 35, 47, 15, true, '1 1 1'); text('TrimSlot', 72, 49, 20, true, '1 1 1');
  rect(286, 29, 108, 22, '0.84 0.97 0.91'); text(receipt.status.toUpperCase(), 298, 44, 8, true, '0.06 0.39 0.25');
  label('PAYMENT RECEIPT', 30, 94);
  text(receipt.type === 'PLAN' ? 'Plan payment' : 'Booking payment', 30, 120, 21, true, '1 1 1');
  text('A clear record of your TrimSlot payment', 30, 139, 9, false, '0.82 0.87 0.94');
  rect(28, 170, 364, 76, '0.95 0.97 0.99', '0.84 0.89 0.95');
  label('AMOUNT RECEIVED', 42, 188); text(money(receipt.amount_kobo), 42, 213, 22, true, '0.06 0.15 0.30');
  label('RECEIPT NUMBER', 235, 188); text(receipt.receipt_number, 235, 207, 9, true);
  label('RECEIPT DATE', 42, 229);
  text(new Date(receipt.paid_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }), 42, 240, 8, true);
  let top = 270;
  const section = (title: string) => { label(title, 30, top); top += 12; };
  section(receipt.type === 'PLAN' ? 'PLAN DETAILS' : 'BOOKING DETAILS');
  row(receipt.type === 'PLAN' ? 'Plan purchased' : 'Service booked', receipt.item || receipt.service, top); top += 16;
  row('Barber / shop', receipt.shop || receipt.barber, top); top += 16;
  row('Location', receipt.location, top); top += 16;
  if (receipt.type === 'PLAN') {
    row('Sessions included', receipt.sessions_total, top); top += 16;
    row('Validity period', receipt.validity_days ? receipt.validity_days + ' days' : null, top); top += 16;
    if (receipt.expires_at) { row('Valid until', new Date(receipt.expires_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' }), top); top += 16; }
  } else { row('Appointment', [receipt.appointment_date, receipt.appointment_time].filter(Boolean).join(' · '), top); top += 16; }
  top += 2; section('CUSTOMER DETAILS');
  row('Customer name', receipt.customer_name, top); top += 16;
  row('Email', receipt.customer_email, top); top += 16;
  row('Phone', receipt.customer_phone, top); top += 16;
  top += 2; section('PAYMENT DETAILS');
  row('Payment provider', receipt.payment_provider, top); top += 16;
  row('Payment status', receipt.status, top); top += 16;
  row('Transaction reference', receipt.reference, top); top += 16;
  const qr = QRCode.create(verificationUrl, { errorCorrectionLevel: 'M' });
  const qrSize = 88, cell = qrSize / qr.modules.size, qx = 38, qtop = 486;
  rect(28, 478, 364, 98, '0.96 0.97 0.99', '0.86 0.89 0.93');
  commands.push('0.03 0.10 0.23 rg');
  for (let r = 0; r < qr.modules.size; r++) for (let c = 0; c < qr.modules.size; c++) {
    if (qr.modules.data[r * qr.modules.size + c]) {
      const xx = qx + c * cell, yy = PAGE_H - qtop - (r + 1) * cell;
      commands.push(`${xx.toFixed(2)} ${yy.toFixed(2)} ${(cell + 0.08).toFixed(2)} ${(cell + 0.08).toFixed(2)} re f`);
    }
  }
  text('Thank you for choosing TrimSlot.', 145, 510, 10, true);
  text('Scan to verify this receipt and its current payment status.', 145, 529, 7.5, false, '0.36 0.43 0.54');
  text('No customer contact or transaction details are shown publicly.', 145, 541, 7, false, '0.36 0.43 0.54');
  text('trimslot.com.ng', 145, 559, 8, true, '0.19 0.34 0.66');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n%TrimSlot\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf, 'ascii')); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}
