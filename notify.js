const sg = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sg.setApiKey(process.env.SENDGRID_API_KEY);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Never throws, never blocks the request.
async function sendEmail(to, subject, html) {
  if (!process.env.SENDGRID_API_KEY) return console.log(`[MOCK EMAIL] to=${to} subject="${subject}"`);
  try {
    await sg.send({ to, from: process.env.SENDGRID_FROM_EMAIL, subject, html });
  } catch (e) {
    console.error('SendGrid failed:', e.response?.body || e.message);
  }
}

async function sendSMS(phone, text) {
  if (!process.env.MSG91_KEY) return console.log(`[MOCK SMS] to=${phone} text="${text}"`);
  try {
    // MSG91 Flow API: create a flow template with a ##VAR1## variable in the MSG91 dashboard.
    const r = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: process.env.MSG91_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: process.env.MSG91_TEMPLATE_ID,
        short_url: '0',
        recipients: [{ mobiles: `91${phone}`, VAR1: text }],
      }),
    });
    if (!r.ok) console.error('MSG91 failed:', r.status, await r.text());
  } catch (e) {
    console.error('MSG91 failed:', e.message);
  }
}

module.exports = { sendEmail, sendSMS, esc };
