'use strict';

const cron = require('node-cron');
const reportService = require('../services/reportService');
const { todayPktDateStr } = require('../utils/dateUtils');

/**
 * Send daily / weekly / monthly attendance reports to Managers + HR Admin.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {object} [opts]
 */
async function runAttendanceReport(period, opts = {}) {
  return reportService.sendAttendanceReports(period, opts);
}

function schedule() {
  // Daily report after absent-marker (23:30) so auto check-outs are included.
  cron.schedule(
    '45 23 * * *',
    async () => {
      try {
        const result = await runAttendanceReport('daily', { date: todayPktDateStr() });
        // eslint-disable-next-line no-console
        console.log('[cron:attendanceReport:daily]', {
          from: result.from,
          sent: result.results.filter((r) => r.sent).length,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron:attendanceReport:daily] failed:', err.message);
      }
    },
    { timezone: 'Asia/Karachi' }
  );

  // Weekly report: Monday 08:00 PKT for the previous Mon–Sun week.
  cron.schedule(
    '0 8 * * 1',
    async () => {
      try {
        // Yesterday falls in the week that just ended (Sun).
        const today = todayPktDateStr();
        const [y, m, d] = today.split('-').map(Number);
        const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
        const yStr = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`;
        const bounds = reportService.weekBoundsPkt(yStr);
        const result = await runAttendanceReport('weekly', {
          from: bounds.from,
          to: bounds.to,
        });
        // eslint-disable-next-line no-console
        console.log('[cron:attendanceReport:weekly]', {
          from: result.from,
          to: result.to,
          sent: result.results.filter((r) => r.sent).length,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron:attendanceReport:weekly] failed:', err.message);
      }
    },
    { timezone: 'Asia/Karachi' }
  );

  // Monthly report: 1st of month 08:15 PKT for the previous calendar month.
  cron.schedule(
    '15 8 1 * *',
    async () => {
      try {
        const today = todayPktDateStr();
        const [y, m] = today.split('-').map(Number);
        const prev = new Date(Date.UTC(y, m - 2, 1)); // previous month
        const prevStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-15`;
        const bounds = reportService.monthBoundsPkt(prevStr);
        const result = await runAttendanceReport('monthly', {
          from: bounds.from,
          to: bounds.to,
        });
        // eslint-disable-next-line no-console
        console.log('[cron:attendanceReport:monthly]', {
          from: result.from,
          to: result.to,
          sent: result.results.filter((r) => r.sent).length,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron:attendanceReport:monthly] failed:', err.message);
      }
    },
    { timezone: 'Asia/Karachi' }
  );
}

module.exports = { runAttendanceReport, schedule };
