'use strict';

const { makeModel } = require('./_base');

const Shift = makeModel({
  table: 'shifts',
  columns: {
    ShiftName: { col: 'shift_name' },
    StartTime: { col: 'start_time' },
    EndTime: { col: 'end_time' },
    GraceMinutes: { col: 'grace_minutes' },
    WorkingDays: { col: 'working_days' }, // text[] — stored/read as an array
  },
});

module.exports = Shift;
