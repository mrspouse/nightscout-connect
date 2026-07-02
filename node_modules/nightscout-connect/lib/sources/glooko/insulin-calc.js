#!/usr/bin/env node

const moment = require('moment');

/**
 * Extracts a numeric insulin total from various potential Glooko entry formats.
 */
function insulin_total_value(entry) {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  var candidates = [
    entry.totalPumpInsulinPerDay,
    entry.totalInsulinPerDay,
    entry.total,
    entry.value,
  ];

  for (var i = 0; i < candidates.length; i++) {
    var num = Number(candidates[i]);
    if (Number.isFinite(num)) {
      return num;
    }
  }

  return undefined;
}

/**
 * Prepares the InsulinPerDay array for Nightscout device status,
 * filtering out data before the last site change and anchoring the last day to the sync timestamp.
 */
function format_insulin_per_day(totalInsulinPerDay, lastSiteChangeTreatment, lastSync) {
  if (!totalInsulinPerDay) return undefined;
  var siteChangeMom = moment(lastSiteChangeTreatment);
  var syncMom = moment(lastSync);

  return totalInsulinPerDay
    // ignore entries prior to latest site change
    .filter(function (entry) {
      var entryMom = moment.utc(entry.timestamp);
      var scMom = moment.utc(lastSiteChangeTreatment);
      var syncMom = moment.utc(lastSync);
      return !entryMom.isBefore(scMom, 'day') && !entryMom.isAfter(syncMom, 'day');
    })
    .map(function (entry) {       // returns one entry per day, timed at 12:00:00
      var updated = Object.assign({}, entry);
      if (moment.utc(entry.timestamp).isSame(moment.utc(lastSync), 'day')) {
        updated.timestamp = lastSync;
        updated.mills = syncMom.valueOf();
      }
      return updated;
    });
}

/**
 * Calculates net insulin delivered since the last site change
 **/
async function calculate_net_pump_insulin(totalInsulinPerDay, lastSiteChangeTreatment, lastSync, pumpAlarms, fetchBaselineTotal) {
  if (!Array.isArray(totalInsulinPerDay) || !lastSiteChangeTreatment) {
    return undefined;
  }

  var siteChangeMoment = moment(lastSiteChangeTreatment);
  if (!siteChangeMoment.isValid()) {
    return undefined;
  }

  var baselineTotal;
  var baselineTime;
  var grossTotal = 0;

  var dailyTotals = [];

  totalInsulinPerDay.forEach(function (entry) {
    var ts = moment(entry.timestamp);
    var total = insulin_total_value(entry);

    if (!ts.isValid() || !Number.isFinite(total)) {
      return;
    }

    var tsUtc = moment.utc(entry.timestamp);
    var scUtc = moment.utc(lastSiteChangeTreatment);

    if (tsUtc.isSame(scUtc, 'day')) {
      if (!baselineTime) {
        baselineTime = ts;
        baselineTotal = total;
      } else if (!ts.isAfter(siteChangeMoment)) {
        // Entry is before or at site change.
        // If current candidate is after site change, or if this one is later than current candidate (closer to site change).
        if (baselineTime.isAfter(siteChangeMoment) || ts.isAfter(baselineTime)) {
          baselineTime = ts;
          baselineTotal = total;
        }
      } else {
        // Entry is after site change.
        // If current candidate is also after site change, and this one is EARLIER (closer to site change).
        if (baselineTime.isAfter(siteChangeMoment) && ts.isBefore(baselineTime)) {
          baselineTime = ts;
          baselineTotal = total;
        }
      }
    }

    if (tsUtc.isSameOrAfter(scUtc, 'day')) {
      grossTotal += total;
    }

    dailyTotals.push({
      timestamp: ts,
      total: total,
    });
  });

  var loadedBaseline = fetchBaselineTotal ? await fetchBaselineTotal(lastSiteChangeTreatment) : undefined;
  if (Number.isFinite(loadedBaseline)) {
    baselineTotal = loadedBaseline;
  }

  if (!Number.isFinite(baselineTotal)) {
    baselineTotal = 0;
  }

  var lastSyncMoment = moment(lastSync);

  return {
    mills: lastSyncMoment.valueOf(),
    timestamp: lastSyncMoment.toISOString(),
    lastSiteChange: lastSiteChangeTreatment,
    insulinDelivered: Number((grossTotal - baselineTotal).toFixed(2)),
    baselineTotal: Number(baselineTotal.toFixed(2)),
  };
}

module.exports = {
  insulin_total_value,
  format_insulin_per_day,
  calculate_net_pump_insulin
};
