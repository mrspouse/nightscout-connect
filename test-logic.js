const moment = require('moment');
const siteChangeMoment = moment('2026-04-04T14:00:45.000Z');
const ts = moment('2026-04-04T12:00:00.000Z');

const isSameDay = ts.isSame(siteChangeMoment, 'day');
const isNotExact = !ts.isSame(siteChangeMoment);
console.log(isSameDay, isNotExact);
