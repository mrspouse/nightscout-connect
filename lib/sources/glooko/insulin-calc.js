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
      return !moment(entry.timestamp).isBefore(siteChangeMom, 'day');
    })
    .map(function (entry) {       // returns one entry per day, timed at 12:00:00
      var updated = Object.assign({}, entry);
      if (moment(entry.timestamp).isSame(syncMom, 'day')) {
        updated.timestamp = lastSync;
        updated.mills = syncMom.valueOf();
      }
      return updated;
    });
}

/**
 * Calculates net insulin delivered since the last site change,
 * and estimates insulin remaining in the reservoir if a low insulin alarm has occurred.
 */
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
  var lowInsulinAlarmMessage = 'Insulin levels remaining in Pod are low. Change Pod soon.';
  var lowInsulinAlarmMoment;

  if (Array.isArray(pumpAlarms)) {
    pumpAlarms.forEach(function (alarm) {
      if (!alarm || alarm.value !== lowInsulinAlarmMessage) {
        return;
      }

      var alarmMoment = moment(alarm.pumpTimestamp || alarm.timestamp);
      if (!alarmMoment.isValid() || alarmMoment.isBefore(siteChangeMoment)) {
        return;
      }

      if (!lowInsulinAlarmMoment || alarmMoment.isAfter(lowInsulinAlarmMoment)) {
        lowInsulinAlarmMoment = alarmMoment;
      }
    });
  }

  var dailyTotals = [];

  totalInsulinPerDay.forEach(function (entry) {
    var ts = moment(entry.timestamp);
    var total = insulin_total_value(entry);

    if (!ts.isValid() || !Number.isFinite(total)) {
      return;
    }

    if (!ts.isAfter(siteChangeMoment)) {
      if (!baselineTime || ts.isAfter(baselineTime)) {
        baselineTime = ts;
        baselineTotal = total;
      }
    }

    if (ts.isSameOrAfter(siteChangeMoment, 'day')) {
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

  var insulinRemaining = '50+';
  var lastSyncMoment = moment(lastSync);

  if (lowInsulinAlarmMoment && lastSyncMoment.isValid() && !lastSyncMoment.isBefore(lowInsulinAlarmMoment)) {
    var startingIndex = -1;
    dailyTotals.sort(function (a, b) {
      return a.timestamp.valueOf() - b.timestamp.valueOf();
    });

    for (var i = 0; i < dailyTotals.length; i++) {
      if (dailyTotals[i].timestamp.isSameOrAfter(lowInsulinAlarmMoment)) {
        startingIndex = i;
        break;
      }
    }

    var remainingUnits = 50;

    if (startingIndex > -1) {
      var previousTotal = dailyTotals[startingIndex].total;
      for (var j = startingIndex + 1; j < dailyTotals.length; j++) {
        var currentTotal = dailyTotals[j].total;
        if (currentTotal === previousTotal) {
          continue;
        }

        var delta = currentTotal - previousTotal;
        if (delta > 0) {
          remainingUnits -= delta;
        }
        previousTotal = currentTotal;
      }
    }

    insulinRemaining = '< ' + Number(Math.max(remainingUnits, 0).toFixed(2));
  }

  return {
    mills: lastSyncMoment.valueOf(),
    timestamp: lastSyncMoment.toISOString(),
    insulinDelivered: Number((grossTotal - baselineTotal).toFixed(2)),
    insulinRemaining: insulinRemaining,
    baselineTotal: Number(baselineTotal.toFixed(2)),
  };
}

module.exports = {
  insulin_total_value,
  format_insulin_per_day,
  calculate_net_pump_insulin
};
