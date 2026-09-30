const ref = new URLSearchParams(location.search).get('reference');
const box = document.getElementById('box');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
fetch('/api/payments/mock/' + encodeURIComponent(ref)).then(r => r.json()).then(d => {
  if (d.error) { box.innerHTML = '<div class="err">' + esc(d.error.message) + '</div>'; return; }
  const amt = '₦' + (d.amount_kobo / 100).toLocaleString('en-NG');
  box.innerHTML = '<h2 style="justify-content:center">Mock Paystack checkout</h2><p class="muted">' + esc(d.service_name) + '</p><h1>' + amt + '</h1><p class="small muted">Ref: ' + esc(d.reference) + '</p>' +
    '<div class="btns" style="justify-content:center;margin-top:16px"><button class="btn green" id="pay">Simulate successful payment</button><button class="btn sec" id="cancel">Cancel / abandon</button></div>';
  document.getElementById('pay').onclick = async () => {
    document.getElementById('pay').disabled = true;
    const r = await fetch('/api/payments/mock/' + encodeURIComponent(ref) + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    location.href = j.next || '/';
  };
  document.getElementById('cancel').onclick = () => { location.href = '/api/payments/callback?reference=' + encodeURIComponent(ref); };
});
