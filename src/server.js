'use strict';

const app = require('./app');
const env = require('./config/env');
const absentMarker = require('./jobs/absentMarker');
const attendanceReminders = require('./jobs/attendanceReminders');
const attendanceReports = require('./jobs/attendanceReports');

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`ALMS backend listening on port ${env.port} (${env.nodeEnv})`);
});

// Turn the noisy unhandled 'error' crash into a clear, actionable message.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${env.port} is already in use — another instance is likely still ` +
        `running. Stop it, or set a different PORT in .env.`
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

// Optional: schedule background jobs unless disabled.
if (process.env.ENABLE_CRON !== 'false') {
  absentMarker.schedule();
  attendanceReminders.schedule();
  attendanceReports.schedule();
  // eslint-disable-next-line no-console
  console.log(
    'Cron scheduled: absent 23:30, reminders every minute, reports daily 23:45 / weekly Mon 08:00 / monthly 1st 08:15 (Asia/Karachi)'
  );
}

// Graceful shutdown.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down`);
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(1), 10000).unref();
}
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

module.exports = server;
