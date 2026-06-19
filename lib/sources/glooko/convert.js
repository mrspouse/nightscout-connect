#!/usr/bin/env node

const moment = require('moment');
const insulinCalc = require('./insulin-calc');

  // Glooko API typically returns Unix timestamps in seconds.
  // JavaScript Date and Nightscout 'mills' fields require milliseconds.
function normalizeTime(item, rawTime) {
  var val = Number(rawTime);
  var isValid = Number.isFinite(val);
  if (isValid && val < 4000000000) {    // check if seconds only
    val = val * 1000;
  }

  return Object.assign({
    mills: isValid ? val : undefined,
    timestamp:
      item.timestamp ||
      (isValid ? new Date(val).toISOString() : undefined),
  }, item);
}

function array_from_endpoint(results, endpointName, nestedKey) {
  var endpoint = results[endpointName] || {};
  var data = endpoint.data;
  if (Array.isArray(data)) {
    return data;
  }

  if (data && Array.isArray(data[nestedKey])) {
    return data[nestedKey];
  }

  return undefined;
}

function objects_from_reservoir_change(results, endpointName) {
  var endpoint = results[endpointName] || {};
  var data = endpoint.data || {};
  var siteChange = data.series?.reservoirChange;

  if (Array.isArray(siteChange)) {
    return siteChange.map(function (item) {
      return normalizeTime(item, item.x);
    });
  }

  if (!siteChange || typeof siteChange !== 'object' || Array.isArray(siteChange)) {
    return undefined;
  }

  return Object.keys(siteChange)
    .sort()
    .map(function (mills) {
      return normalizeTime(siteChange[mills], mills);
    });
}

function objects_from_cgm_change(results, endpointName) {
  var endpoint = results[endpointName] || {};
  var data = endpoint.data || {};
  var cgmChange = data.series?.cgmSensorChange;

  if (Array.isArray(cgmChange)) {
    return cgmChange.map(function (item) {
      return normalizeTime(item, item.x);
    });
  }

  if (!cgmChange || typeof cgmChange !== 'object' || Array.isArray(cgmChange)) {
    return undefined;
  }

  return Object.keys(cgmChange)
    .sort()
    .map(function (mills) {
      return normalizeTime(cgmChange[mills], mills);
    });
}

function objects_from_daily_totals(results, endpointName) {
  var endpoint = results[endpointName] || {};
  var data = endpoint.data || {};
  var dayTotals = data.series?.totalInsulinPerDay || data.series?.dailyInsulinTotals;
  console.log('GLOOKO daily totals found:', !!dayTotals, 'keys:', dayTotals ? Object.keys(dayTotals).length : 0);

  if (!dayTotals || typeof dayTotals !== 'object' || Array.isArray(dayTotals)) {
    return undefined;
  }

  return Object.keys(dayTotals)
    .sort()
    .map(function (mills) {
      return normalizeTime(dayTotals[mills], mills);
    });
}

function boluses_from_histories(results) {
  var histories = results?.Histories?.data?.histories;
  if (!Array.isArray(histories)) {
    return undefined;
  }

  return histories
    .filter(function (entry) {
      return entry.type === 'pumps_normal_boluses';
    })
    .map(function (entry) {
      return entry.item;
    });
}

function existing_daily_treatment(records, createdAt) {
  return (records || []).find(function (t) {
    return moment.utc(t.created_at).isSame(moment.utc(createdAt), 'day');
  });
}

function number_or_nan(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }
  return Number(value);
}

function higher_daily_total(glookoValue, existingTreatment) {
  var glookoTotal = number_or_nan(glookoValue);
  var existingTotal = existingTreatment ? number_or_nan(existingTreatment.insulin) : NaN;
  if (Number.isFinite(glookoTotal) && Number.isFinite(existingTotal)) {
    return Math.max(glookoTotal, existingTotal);
  }
  if (Number.isFinite(glookoTotal)) {
    return glookoTotal;
  }
  if (Number.isFinite(existingTotal)) {
    return existingTotal;
  }
  return undefined;
}

function existing_sync_timestamp(existing) {
  if (!existing) {
    return null;
  }

  var existingSync = existing.syncTimestamp;
  if (!existingSync && existing.notes) {
    try {
      var notes = JSON.parse(existing.notes);
      existingSync = notes.pumpSync || notes.firstSync || notes.lastSyncISO;
    } catch (e) { }
  }

  return existingSync;
}

function daily_total_notes(element, syncTimestamp, lastSyncISO) {
  var notesElement = Object.assign({}, element);
  if (syncTimestamp) {
    var ordered = { pumpSync: syncTimestamp };
    Object.assign(ordered, notesElement);
    delete ordered.timestamp;
    delete ordered.x;
    delete ordered.y;
    notesElement = ordered;
  }

  if (lastSyncISO) {
    notesElement.currentSync = lastSyncISO;
  }

  return JSON.stringify(notesElement);
}

function daily_total_treatment(eventType, total, createdAt, existing, element, lastSyncISO) {
  var treatment = {};
  treatment.eventType = eventType;
  treatment.created_at = createdAt;
  if (Number.isFinite(total)) {
    treatment.insulin = total;
  }

  var existingSync = existing_sync_timestamp(existing);
  if (existingSync) {
    treatment.syncTimestamp = existingSync;
  } else if (lastSyncISO) {
    treatment.syncTimestamp = lastSyncISO;
  }

  treatment.notes = daily_total_notes(element, treatment.syncTimestamp, lastSyncISO);
  return treatment;
}

function daily_total_created_at(element, timestampDelta) {
  var baseTimestamp =
    element.timestamp ||
    (Number.isFinite(element.mills)
      ? new Date(element.mills).toISOString()
      : undefined);

  if (!baseTimestamp) {
    return undefined;
  }

  var f_time = new Date(baseTimestamp).getTime();
  return moment.utc(f_time).startOf('day').add(timestampDelta, 'ms').toISOString();
}

function adjusted_daily_total_entry(element, timestampDelta, nsContext) {
  var createdAt = daily_total_created_at(element, timestampDelta);
  if (!createdAt) {
    return undefined;
  }

  var updated = Object.assign({}, element);
  var existingDailyBasal = existing_daily_treatment(nsContext.existingDailyBasal, createdAt);
  var existingDailyBolus = existing_daily_treatment(nsContext.existingDailyBolus, createdAt);
  var basalTotal = higher_daily_total(element.basalUnitsPerDay, existingDailyBasal);
  var bolusTotal = higher_daily_total(element.bolusUnitsPerDay, existingDailyBolus);

  if (Number.isFinite(basalTotal)) {
    updated.basalUnitsPerDay = basalTotal;
  }
  if (Number.isFinite(bolusTotal)) {
    updated.bolusUnitsPerDay = bolusTotal;
  }
  if (Number.isFinite(basalTotal) || Number.isFinite(bolusTotal)) {
    var total = Number((
      (Number.isFinite(basalTotal) ? basalTotal : 0) +
      (Number.isFinite(bolusTotal) ? bolusTotal : 0)
    ).toFixed(2));
    updated.totalInsulinPerDay = total;
    updated.totalPumpInsulinPerDay = total;
  }

  Object.defineProperty(updated, 'createdAt', { value: createdAt });
  Object.defineProperty(updated, 'existingDailyBasal', { value: existingDailyBasal });
  Object.defineProperty(updated, 'existingDailyBolus', { value: existingDailyBolus });
  return updated;
}


function pump_alarms(results) {
  var histories = results?.Histories?.data?.histories;
  if (!Array.isArray(histories)) {
    return undefined;
  }

  return histories
    .filter(function (entry) {
      return entry.type === 'pumps_alarms';
    })
    .map(function (entry) {
      return entry.item;
    });
}

function assign_objects(batch) {
  var lastPumpSyncTimestamp = batch.lastPumpSyncTimestamp;
  var data = batch.results;
  return {
    foods: array_from_endpoint(data, 'Foods', 'foods'),
    insulins: array_from_endpoint(data, 'Insulins', 'insulins'),
    normalBoluses: boluses_from_histories(data),
    scheduledBasals: array_from_endpoint(data,'Pump Basal', 'scheduledBasals'),
    reservoirChange: objects_from_reservoir_change(data, 'Reservoir Change'),
    cgmSensorChange: objects_from_cgm_change(data, 'cgmSensorChange'),
    dailyInsulinTotals: objects_from_daily_totals(data, 'Insulin Per Day'),
    pumpAlarms: pump_alarms(data),
    lastSync: lastPumpSyncTimestamp
  }  
}

async function generate_nightscout_treatments(batch, timestampDelta, nsContext) {
  // nsContext is provided by the caller (index.js or standalone CLI) and contains:
  //   existingSiteChanges: Array — pre-fetched Pump Site Change treatments
  //   existingAlarms: Array — pre-fetched devicestatus alarm records
  //   fetchBaselineTotal: async Function — fetches insulin baseline (called mid-transform)
  nsContext = nsContext || { existingSiteChanges: [], existingAlarms: [] };

  var InsulinPerDay;
  var inputBatch = assign_objects(batch);
  
  const foods = inputBatch.foods;
  const insulins = inputBatch.insulins;
  const pumpBoluses = inputBatch.normalBoluses;
  const scheduledBasals = inputBatch.scheduledBasals;
  const reservoirChange = inputBatch.reservoirChange;
  const cgmChange = inputBatch.cgmSensorChange;
  const totalInsulinPerDay = inputBatch.dailyInsulinTotals;
  const pumpAlarms = inputBatch.pumpAlarms;
  const lastSync = inputBatch.lastSync;
  const lastSyncISO = lastSync ? moment(lastSync).toISOString() : undefined;
  const adjustedTotalInsulinPerDay = totalInsulinPerDay
    ? totalInsulinPerDay
      .map(function (element) {
        return adjusted_daily_total_entry(element, timestampDelta, nsContext);
      })
      .filter(Boolean)
    : undefined;

  var existingSiteChanges = nsContext.existingSiteChanges || [];
  var existingAlarms = nsContext.existingAlarms || [];
  
  // Collect all known sync timestamps to find the "closest after" logic
  var allKnownSyncs = [];
  if (lastSyncISO) allKnownSyncs.push(lastSyncISO);
  existingSiteChanges.forEach(function(t) {
    if (t.syncTimestamp && allKnownSyncs.indexOf(t.syncTimestamp) === -1) {
      allKnownSyncs.push(t.syncTimestamp);
    }
  });
  existingAlarms.forEach(function(t) {
    var s = t.syncTimestamp || t.lastSync || t.lastSyncISO;
    if (s && allKnownSyncs.indexOf(s) === -1) {
      allKnownSyncs.push(s);
    }
  });
  allKnownSyncs.sort();

  var treatments = []
  
  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      var f_date = new Date(element.timestamp);
      var f_time = f_date.getTime();

      var result = insulins.filter(function(el) {
          var i_time = new Date(el.timestamp).getTime();
          return Math.abs(f_time - i_time) < 46 * 60000;
      });
      
      var insulin = result[0];
      if (insulin != undefined) {
        var i_time = new Date(insulin.timestamp).getTime();
        treatment.eventType = 'Meal Bolus';
        treatment.eventTime = new Date(i_time + timestampDelta).toISOString();
        treatment.insulin = insulin.value;
        
        treatment.preBolus = (f_time - i_time) / 60000;
      } else {
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_time + timestampDelta).toISOString();
      }

      treatment.carbs = element.carbs;
      treatment.notes = JSON.stringify(element);
      
      treatments.push(treatment);

    });    
  }

  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};

      var f_date = new Date(element.timestamp);
      var f_time = f_date.getTime();

      var result = (foods || []).filter(function(el) {
          var i_time = new Date(el.timestamp).getTime();
          return Math.abs(f_time - i_time) < 46 * 60000;
      });

      if (result[0] == undefined) {
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_time + timestampDelta).toISOString();
        treatment.insulin = element.value;
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      var f_time = new Date(element.pumpTimestamp).getTime();
      if (element.carbsInput == 0) {
        treatment.eventType = 'Correction Bolus';
      } else {
        treatment.eventType = 'Meal Bolus';
      }
      treatment.eventTime = new Date(f_time + timestampDelta).toISOString();
      treatment.insulin = element.insulinDelivered;
      treatment.carbs = element.carbsInput;
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
      });
    console.log('pumpBolus elements processed:', pumpBoluses.length);
    }

  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment = {};
      
      var f_time = new Date(element.pumpTimestamp).getTime();
      treatment.eventType = 'Temp Basal';
      treatment.created_at = new Date(f_time + timestampDelta).toISOString();
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = element.duration / 60;
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
  }

  var lastSiteChangeTreatment = null;

  if (reservoirChange) {
    reservoirChange.forEach(function(element) {
      var baseTimestamp =
        element.timestamp ||
        (Number.isFinite(element.mills)
          ? new Date(element.mills).toISOString()
          : undefined);
      element.deviceName = 'Omnipod 5';
      element.device = 'Insulet Omnipod® 5 System';

      if (!baseTimestamp) {
        return;
      }

      var f_time = new Date(baseTimestamp).getTime();

      var siteChangeTreatment = {};
      siteChangeTreatment.eventType = 'Pump Site Change';
      var createdAt = new Date(f_time + timestampDelta).toISOString();
      siteChangeTreatment.created_at = createdAt;

      // Identify the invariant glooko mills for this element (stable across refreshes).
      var elementMills = Number.isFinite(element.mills)
        ? element.mills
        : (Number.isFinite(Number(element.x)) ? Number(element.x) * 1000 : NaN);

      var existing = existingSiteChanges.find(function(t) {
        // Primary: exact created_at match (works when timestampDelta is stable).
        if (moment(t.created_at).valueOf() === moment(createdAt).valueOf()) {
          return true;
        }
        // Fallback: match on the raw glooko mills value stored in notes.
        // This handles cases where timestampDelta has changed between syncs,
        // which would cause the computed created_at to differ from what was stored.
        if (t.notes && Number.isFinite(elementMills)) {
          try {
            var n = JSON.parse(t.notes);
            var nMills = Number.isFinite(Number(n.mills))
              ? Number(n.mills)
              : (Number.isFinite(Number(n.x)) ? Number(n.x) * 1000 : NaN);
            if (Number.isFinite(nMills) && nMills === elementMills) {
              return true;
            }
          } catch (e) { }
        }
        return false;
      });
      var existingSync = null;
      if (existing) {
        existingSync = existing.syncTimestamp;
        if (!existingSync && existing.notes) {
          try {
            var notes = JSON.parse(existing.notes);
            existingSync = notes.pumpSync || notes.firstSync || notes.lastSyncISO;
          } catch (e) { }
        }
      }

      if (existingSync) {
        siteChangeTreatment.syncTimestamp = existingSync;
      } else if (lastSyncISO) {
        siteChangeTreatment.syncTimestamp = lastSyncISO;
      }

      if (siteChangeTreatment.syncTimestamp) {
        var ordered = { pumpSync: siteChangeTreatment.syncTimestamp };
        Object.assign(ordered, element);
        delete ordered.timestamp;
        delete ordered.x;
        delete ordered.y;
        element = ordered;
      }

      if (lastSyncISO) {
        element.currentSync = lastSyncISO;
      }
      siteChangeTreatment.notes = JSON.stringify(element);

      if (!lastSiteChangeTreatment || createdAt > lastSiteChangeTreatment) {
        lastSiteChangeTreatment = createdAt;
      }

      treatments.push(siteChangeTreatment);
    });
    console.log('reservoirChange elements processed:', reservoirChange.length);
  }

  if (cgmChange) {
    cgmChange.forEach(function(element) {
      var baseTimestamp =
        element.timestamp ||
        (Number.isFinite(element.mills)
          ? new Date(element.mills).toISOString()
          : undefined);
      element.deviceName = 'Omnipod 5';
      element.device = 'Insulet Omnipod® 5 System';

      if (!baseTimestamp) {
        return;
      }

      var f_time = new Date(baseTimestamp).getTime();

      var cgmChangeTreatment = {};
      cgmChangeTreatment.eventType = 'Sensor Change';
      var createdAt = new Date(f_time + timestampDelta).toISOString();
      cgmChangeTreatment.created_at = createdAt;

      // Identify the invariant glooko mills for this element (stable across refreshes).
      var elementMills = Number.isFinite(element.mills)
        ? element.mills
        : (Number.isFinite(Number(element.x)) ? Number(element.x) * 1000 : NaN);

      var existing = (nsContext.existingSensorChanges || []).find(function(t) {
        if (moment(t.created_at).valueOf() === moment(createdAt).valueOf()) {
          return true;
        }
        if (t.notes && Number.isFinite(elementMills)) {
          try {
            var n = JSON.parse(t.notes);
            var nMills = Number.isFinite(Number(n.mills))
              ? Number(n.mills)
              : (Number.isFinite(Number(n.x)) ? Number(n.x) * 1000 : NaN);
            if (Number.isFinite(nMills) && nMills === elementMills) {
              return true;
            }
          } catch (e) { }
        }
        return false;
      });

      var existingSync = null;
      if (existing) {
        existingSync = existing.syncTimestamp;
        if (!existingSync && existing.notes) {
          try {
            var notes = JSON.parse(existing.notes);
            existingSync = notes.pumpSync || notes.firstSync || notes.lastSyncISO;
          } catch (e) { }
        }
      }

      if (existingSync) {
        cgmChangeTreatment.syncTimestamp = existingSync;
      } else if (lastSyncISO) {
        cgmChangeTreatment.syncTimestamp = lastSyncISO;
      }

      if (cgmChangeTreatment.syncTimestamp) {
        var ordered = { pumpSync: cgmChangeTreatment.syncTimestamp };
        Object.assign(ordered, element);
        delete ordered.timestamp;
        delete ordered.x;
        delete ordered.y;
        element = ordered;
      }

      if (lastSyncISO) {
        element.currentSync = lastSyncISO;
      }
      cgmChangeTreatment.notes = JSON.stringify(element);

      treatments.push(cgmChangeTreatment);
    });
    console.log('cgmChange elements processed:', cgmChange.length);
  }

  if (adjustedTotalInsulinPerDay) {
    adjustedTotalInsulinPerDay
      .filter(function (element) {
        return !moment.utc(element.timestamp).isAfter(moment.utc(lastSync), 'day');
      })
      .forEach(function (element) {
        var createdAt = element.createdAt;
        var existingDailyBasal = element.existingDailyBasal;
        var dailyTotalBasal = daily_total_treatment(
          'Daily Basal',
          number_or_nan(element.basalUnitsPerDay),
          createdAt,
          existingDailyBasal,
          element,
          lastSyncISO
        );

        treatments.push(dailyTotalBasal);

        var existingDailyBolus = element.existingDailyBolus;
        var dailyTotalBolus = daily_total_treatment(
          'Daily Bolus',
          number_or_nan(element.bolusUnitsPerDay),
          createdAt,
          existingDailyBolus,
          element,
          lastSyncISO
        );

        treatments.push(dailyTotalBolus);
      });
    console.log('totalInsulinPerDay treatments processed:', adjustedTotalInsulinPerDay.length);
  }

  // devicestatus entry from last sync and total insulin
  var devicestatus = [];
  
  if (adjustedTotalInsulinPerDay && lastSync) {
    var lastSyncMoment = moment(lastSync);
    var deviceStatus = {
      created_at: lastSyncMoment.toISOString(),
      mills: lastSyncMoment.valueOf(),
      device: 'Insulet Omnipod® 5 System',
      syncTimestamp: lastSyncMoment.toISOString()
    };
    if (lastSiteChangeTreatment) {
      deviceStatus.lastSiteChange = lastSiteChangeTreatment;
    }
    if (adjustedTotalInsulinPerDay) {
      deviceStatus.InsulinPerDay = insulinCalc.format_insulin_per_day(adjustedTotalInsulinPerDay, lastSiteChangeTreatment, lastSync);

      var netPumpInsulin = await insulinCalc.calculate_net_pump_insulin(
        adjustedTotalInsulinPerDay,
        lastSiteChangeTreatment,
        lastSync,
        pumpAlarms,
        nsContext.fetchBaselineTotal
      );
      if (netPumpInsulin) {
        deviceStatus.reservoir = netPumpInsulin;
      }
    }
    
    devicestatus.push(deviceStatus);
  }

  if (pumpAlarms) {
    pumpAlarms.forEach(function (alarm) {
      var f_time = new Date(alarm.pumpTimestamp).getTime();
      var createdAt = new Date(f_time + timestampDelta).toISOString();
      var device = alarm.pumpName || 'Insulet Omnipod® 5 System';
      
      var existing = existingAlarms.find(function(t) { 
        if (moment(t.created_at).valueOf() === moment(createdAt).valueOf() && t.device === device) {
          return true;
        }
        // Fallback: match on raw mills if stored in record
        if (t.mills && moment(t.mills).valueOf() === moment(f_time + timestampDelta).valueOf() && t.device === device) {
          return true;
        }
        return false;
      });
      
      var existingSync = existing ? (existing.syncTimestamp || existing.lastSync || existing.lastSyncISO) : null;
      var closestSync = allKnownSyncs.find(function(t) { return t >= createdAt; }) || lastSyncISO;

      var alarmStatus = {
        created_at: createdAt,
        device: device,
        alarm: alarm.value,
        syncTimestamp: existingSync || closestSync,
        mills: new Date(f_time + timestampDelta).getTime()
      };
      if (lastSyncISO) {
        alarmStatus.currentSync = lastSyncISO;
      }
      devicestatus.push(alarmStatus);
    });
    console.log('pumpAlarms processed:', pumpAlarms.length);
  }

  console.log('GLOOKO processing complete, returning', treatments.length, 'treatments', 'and', devicestatus.length, 'devicestatus records');
  // console.log(treatments);
  // console.log(JSON.stringify(devicestatus, null, 2));
  return { treatments, devicestatus };
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
module.exports.assign_objects = assign_objects;
