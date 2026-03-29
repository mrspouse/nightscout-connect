#!/usr/bin/env node

const moment = require('moment');

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
    dailyInsulinTotals: objects_from_daily_totals(data, 'Insulin Per Day'),
    pumpAlarms: pump_alarms(data),
    lastSync: lastPumpSyncTimestamp
  }  
}

async function generate_nightscout_treatments(batch, timestampDelta, nsContext) {
  // nsContext is provided by the caller and contains:
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
  const totalInsulinPerDay = inputBatch.dailyInsulinTotals;
  const pumpAlarms = inputBatch.pumpAlarms;
  const lastSync = inputBatch.lastSync;

  var existingSiteChanges = nsContext.existingSiteChanges || [];
  var existingAlarms = nsContext.existingAlarms || [];

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
        treatment.eventTime = new Date(i_time).toISOString();
        treatment.insulin = insulin.value;
        
        treatment.preBolus = (f_time - i_time) / 60000;
      } else {
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = f_date.toISOString();
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
        treatment.eventTime = f_date.toISOString();
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
      var pumpTimestamp =
        element.timestamp ||
        (Number.isFinite(element.mills)
          ? new Date(element.mills).toISOString()
          : undefined);
      element.deviceName = 'Omnipod 5';
      element.device = 'Insulet Omnipod® 5 System';

      if (!pumpTimestamp) {
        return;
      }

      var f_time = new Date(pumpTimestamp).getTime();

      var siteChangeTreatment = {};
      siteChangeTreatment.eventType = 'Pump Site Change';
      siteChangeTreatment.created_at = new Date(f_time + timestampDelta).toISOString();
      
      // Identify the invariant glooko mills for this element (stable across refreshes).
      var elementMills = Number.isFinite(element.mills)
        ? element.mills
        : (Number.isFinite(Number(element.x)) ? Number(element.x) * 1000 : NaN);

      var existing = existingSiteChanges.find(function(t) {
        // Primary: exact created_at match (works when timestampDelta is stable).
        if (moment(t.pumpTimestamp).valueOf() === moment(pumpTimestamp).valueOf()) {
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
          existingSync = existing.pumpSyncTimestamp;
      }

      if (existingSync) {
        siteChangeTreatment.pumpSyncTimestamp = existingSync;
      }

      siteChangeTreatment.notes = JSON.stringify(element);

      if (!lastSiteChangeTreatment || siteChangeTreatment.pumpSyncTimestamp > lastSiteChangeTreatment) {
        lastSiteChangeTreatment = siteChangeTreatment.pumpSyncTimestamp;
      }

      treatments.push(siteChangeTreatment);
    });
    console.log('reservoirChange elements processed:', reservoirChange.length);
  }

  // devicestatus entry from last sync and total insulin
  var devicestatus = [];
  
  if (totalInsulinPerDay && lastSync) {
    var lastSyncMoment = moment(lastSync);
    var deviceStatus = {
      created_at: lastSyncMoment.toISOString(),
      mills: lastSyncMoment.valueOf(),
      device: 'Insulet Omnipod® 5 System',
      lastSync: lastSyncMoment.toISOString()
    };
    if (lastSiteChangeTreatment) {
      deviceStatus.lastSiteChange = lastSiteChangeTreatment;
    }
    if (totalInsulinPerDay) {
      var siteChangeMom = moment(lastSiteChangeTreatment);
      var syncMom = moment(lastSync);

      InsulinPerDay = totalInsulinPerDay
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
      deviceStatus.InsulinPerDay = InsulinPerDay;

      var netPumpInsulin = await calculate_net_pump_insulin(
        totalInsulinPerDay,
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
        return moment(t.created_at).valueOf() === moment(createdAt).valueOf() && t.device === device; 
      });
      var existingSync = existing ? existing.lastSync : null;

      var alarmStatus = {
        created_at: createdAt,
        device: device,
        alarm: alarm.value,
        lastSync: existingSync,
        mills: new Date(f_time + timestampDelta).getTime()
      };
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

/*
*****************************************************************
* Standalone run args
*****************************************************************
*/ 

const fs = require('fs');
const path = require('path');

function parse_args(argv) {
  var args = {
    input: null,
    output: null,
    offset: 0,
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];

    if (arg === '--input' || arg === '-i') {
      args.input = argv[++i];
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[++i];
    } else if (arg === '--offset') {
      args.offset = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function print_help() {
  console.log([
    'Usage: node lib/sources/glooko/convert.js --input <batch.json> [--offset <ms>] [--output <out.json>]',
    '',
    'Options:',
    '  -i, --input    JSON file containing Glooko batch payload',
    '  -o, --output   Optional path to write transformed treatments JSON',
    '      --offset   Timestamp delta in milliseconds (default: 0)',
    '  -h, --help     Show this message',
  ].join('\n'));
}

function read_json_file(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

const { createNightscoutHelper } = require('./lib/sources/glooko/nightscout-context');

async function run_cli(argv) {
  var args = parse_args(argv);

  if (args.help) {
    print_help();
    return 0;
  }

  if (Number.isNaN(args.offset)) {
    console.error('Invalid --offset value. Expected a number of milliseconds.');
    return 1;
  }

  var batch = read_json_file(args.input);

  // Build Nightscout context for the transformer
  var ns = createNightscoutHelper({
    url: process.env.NIGHTSCOUT_URL || 'https://ns-drop-gd.fly.dev',
    token: process.env.NIGHTSCOUT_TOKEN || 'aaps-f286719b8dcde96f',
  });
  var inputBatch = assign_objects(batch);
  var hasReservoirChanges = inputBatch.reservoirChange && inputBatch.reservoirChange.length > 0;
  var hasPumpAlarms = inputBatch.pumpAlarms && inputBatch.pumpAlarms.length > 0;
  var nsContext = await ns.buildContext({ hasReservoirChanges, hasPumpAlarms });

  var treatments = await generate_nightscout_treatments(batch, args.offset, nsContext);
  var output = JSON.stringify(treatments, null, 2);

  if (args.output) {
    var outputPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.log('Wrote treatments to', outputPath);
    return 0;
  }

  // process.stdout.write(output + '\n');
  return 0;
}

if (require.main === module) {
  run_cli(process.argv.slice(2))
    .then(function (code) {
      process.exitCode = code;
    })
    .catch(function (error) {
      console.error(error);
      process.exitCode = 1;
    });
}
