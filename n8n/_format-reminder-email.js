const raw = items[0].json;
// Webhook may wrap the POST body under .body
const body =
  raw.body && typeof raw.body === 'object' && (raw.body.event || raw.body.to)
    ? { ...raw.body }
    : { ...raw };

const to = body.to || body.employeeEmail;
const employeeName = body.employeeName || body.data?.employeeName || '';
const type = body.data?.type || (String(body.subject || '').toLowerCase().includes('check out') ? 'checkout' : 'checkin');
const date = body.data?.date || '';
const shiftTime = body.data?.shiftTime || '';
const checkInPkt = body.data?.checkInTimePkt || null;
const subject =
  body.subject ||
  (type === 'checkout'
    ? `Reminder: please check out (${date})`
    : `Reminder: please check in (${date})`);

if (!to) {
  throw new Error('Reminder payload missing "to" email');
}

const brand = {
  navy: '#07111F',
  teal: '#14B8A6',
  tealDark: '#0F766E',
  ink: '#0B1220',
  muted: '#5B6575',
  line: '#E6E9EF',
  surface: '#F7F8FA',
  white: '#FFFFFF',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const isCheckIn = type === 'checkin';
const title = isCheckIn ? 'Check-in reminder' : 'Check-out reminder';
const lead = isCheckIn
  ? `Your shift starts at <strong style="color:${brand.ink}">${esc(shiftTime)}</strong> PKT today (${esc(date)}).`
  : `Your shift ends at <strong style="color:${brand.ink}">${esc(shiftTime)}</strong> PKT today (${esc(date)}).`;
const detail = isCheckIn
  ? 'Please check in on ALMS if you have not already.'
  : `You are still checked in${checkInPkt ? ` (since ${esc(checkInPkt)})` : ''}. Please check out on ALMS.`;

const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${brand.surface};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${brand.surface};padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${brand.white};border:1px solid ${brand.line};border-radius:12px;overflow:hidden">
          <tr>
            <td style="background:${brand.navy};padding:22px 28px">
              <div style="font-size:20px;font-weight:700;color:${brand.white};letter-spacing:-0.02em">
                Aidapt<span style="color:${brand.teal}">.</span>
              </div>
              <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:0.06em;text-transform:uppercase">
                Attendance &amp; Leave · ALMS
              </div>
            </td>
          </tr>
          <tr>
            <td style="height:3px;background:${brand.teal};font-size:0;line-height:0">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px">
              <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${brand.teal};font-weight:600">
                ${esc(title)}
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:${brand.ink}">
                Hi ${esc(employeeName || 'there')},
              </p>
              <p style="margin:0 0 12px;font-size:14px;color:${brand.muted};line-height:1.55">
                ${lead}
              </p>
              <p style="margin:0 0 22px;font-size:14px;color:${brand.muted};line-height:1.55">
                ${detail}
              </p>
              <div style="padding:14px 16px;background:${brand.surface};border:1px solid ${brand.line};border-radius:8px">
                <p style="margin:0;font-size:12px;color:${brand.muted}">
                  Shift time · <strong style="color:${brand.ink}">${esc(shiftTime)} PKT</strong>
                  ${date ? ` · ${esc(date)}` : ''}
                </p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:${brand.surface};border-top:1px solid ${brand.line}">
              <p style="margin:0;font-size:11px;color:${brand.muted};line-height:1.5">
                Sent by Aidapt ALMS ·
                <a href="https://aidapt.co" style="color:${brand.tealDark};text-decoration:none">aidapt.co</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

return [
  {
    json: {
      to,
      subject,
      html,
      type,
      date,
      shiftTime,
      employeeName,
    },
  },
];
