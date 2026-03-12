#!/usr/bin/env node

var moment = require('moment');
var https = require('https');

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
      var mills = Number(item.x);
      return Object.assign({
        mills: Number.isFinite(mills) ? mills : undefined,
        timestamp:
          item.timestamp ||
          (Number.isFinite(mills)
            ? new Date(mills * 1000).toISOString()
            : undefined),
      }, item);
    });
  }

  if (!siteChange || typeof siteChange !== 'object' || Array.isArray(siteChange)) {
    return undefined;
  }

  return Object.keys(siteChange)
    .sort()
    .map(function (mills) {
      return Object.assign({
        mills: Number(mills),
        timestamp: new Date(Number(mills) * 1000).toISOString(),
      }, siteChange[mills]);
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
      return Object.assign({
        timestamp: new Date(Number(mills) * 1000).toISOString(),
      }, dayTotals[mills]);
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

function loadDevicestatusData(lastSiteChangeTreatment) {
  return new Promise(function (resolve) {
    if (!lastSiteChangeTreatment) {
      resolve(undefined);
      return;
    }

    var url =
      'https://ns-drop-gd.fly.dev/api/v1/devicestatus.json?find[device]=Insulet+Omnipod%C2%AE+5+System&find[lastSiteChange]=' +
      encodeURIComponent(lastSiteChangeTreatment) +
      '&count=2';

    https
      .get(url, function (response) {
        var body = '';

        response.on('data', function (chunk) {
          body += chunk;
        });

        response.on('end', function () {
          if (response.statusCode !== 200) {
            resolve(undefined);
            return;
          }

          try {
            var data = JSON.parse(body);
            if (!Array.isArray(data) || data.length < 2) {
              resolve(undefined);
              return;
            }

            var secondRecord = data[1] || {};

            if (Number.isFinite(Number(secondRecord.totalPumpInsulinPerDay))) {
              resolve(Number(secondRecord.totalPumpInsulinPerDay));
              return;
            }

            if (secondRecord.reservoir && Number.isFinite(Number(secondRecord.reservoir.baselineTotal))) {
              resolve(Number(secondRecord.reservoir.baselineTotal));
              return;
            }

            var insulinPerDay = Array.isArray(secondRecord.InsulinPerDay) ? secondRecord.InsulinPerDay : [];
            if (insulinPerDay.length > 0) {
              var insulinTotal = insulin_total_value(insulinPerDay[insulinPerDay.length - 1]);
              resolve(Number.isFinite(insulinTotal) ? insulinTotal : undefined);
              return;
            }

            resolve(undefined);
          } catch (error) {
            resolve(undefined);
          }
        });
      })
      .on('error', function () {
        resolve(undefined);
      });
  });
}

async function calculate_net_pump_insulin(totalInsulinPerDay, lastSiteChangeTreatment, lastSync, pumpAlarms) {
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

  var loadedBaseline = await loadDevicestatusData(lastSiteChangeTreatment);
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
    timestamp: lastSync || new Date().toISOString(),
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

async function generate_nightscout_treatments(batch, timestampDelta) {
  var InsulinPerDay;
  inputBatch = assign_objects(batch);
  
  const foods = inputBatch.foods;
  const insulins = inputBatch.insulins;
  const pumpBoluses = inputBatch.normalBoluses;
  const scheduledBasals = inputBatch.scheduledBasals;
  const reservoirChange = inputBatch.reservoirChange;
  const totalInsulinPerDay = inputBatch.dailyInsulinTotals;
  const pumpAlarms = inputBatch.pumpAlarms;
  const lastSync = inputBatch.lastSync;
  
  // console.log("FOODS  ", foods);
  // console.log("INSULINS  ", insulins );
  // console.log("BOLUS  ", pumpBoluses );
  // console.log("BASAL  ", scheduledBasals);
  // console.log("RESERVOIR CHANGE  ", reservoirChange );
  // console.log("DAY TOTALS  ", totalInsulinPerDay );
  // console.log("LAST SYNC  ", lastSync );

  var treatments = []
  
  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime()  + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime()  + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = insulins.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      
      insulin = result[0];
      if (insulin != undefined) {
        var i_date = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        // 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 millseconds
        treatment.eventTime = new Date(i_date ).toISOString( );
        treatment.insulin = insulin.value;
        
        treatment.preBolus = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date ).toISOString( );
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
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime() + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date

      var i_date = new Date();
      var result = foods.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString( );
        treatment.insulin = element.value;
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.pumpTimestamp);
      if (element.carbsInput == 0) {
        treatment.eventType = 'Correction Bolus';
      } else {
        treatment.eventType = 'Meal Bolus';
      }
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString();
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
      
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Temp Basal';
      treatment.created_at = new Date(f_date + timestampDelta).toISOString( );
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
          ? new Date(element.mills * 1000).toISOString()
          : undefined);
      element.deviceName = 'Omnipod 5';
      element.device = 'Insulet Omnipod® 5 System';

      if (!baseTimestamp) {
        return;
      }

      var f_date = moment(baseTimestamp);

      var siteChangeTreatment = {};
      siteChangeTreatment.eventType = 'Pump Site Change';
      var createdAt = new Date(f_date + timestampDelta).toISOString();
      siteChangeTreatment.created_at = createdAt;
      siteChangeTreatment.notes = JSON.stringify(element);

      if (!lastSiteChangeTreatment || createdAt > lastSiteChangeTreatment) {
        lastSiteChangeTreatment = createdAt;
      }

      treatments.push(siteChangeTreatment);
    });
    console.log('reservoirChange elements processed:', reservoirChange.length);
  }

  // devicestatus entry from last sync and total insulin
  var devicestatus = [];
  
  if (totalInsulinPerDay && lastSync) {
    var deviceStatus = {
      created_at: lastSync || new Date().toISOString(),
      device: 'Insulet Omnipod® 5 System'
    };
    if (lastSync) {
      deviceStatus.lastSync = lastSync;
    }
    if (lastSiteChangeTreatment) {
      deviceStatus.lastSiteChange = lastSiteChangeTreatment;
    }
    if (totalInsulinPerDay) {
      InsulinPerDay = totalInsulinPerDay
        .filter(function (entry) {
          return !moment(entry.timestamp).isBefore(moment(lastSiteChangeTreatment),'day');
        })
        .map(function (entry) {       // returns one entry per day, timed at 12:00:00
          // ignore entries prior to latest site change
          var updated = Object.assign({}, entry);
          if (moment(entry.timestamp).isSame(moment(lastSync),'day')) {
            updated.timestamp = lastSync;
          }
          return updated;
        });    
      deviceStatus.InsulinPerDay = InsulinPerDay;

      var netPumpInsulin = await calculate_net_pump_insulin(
        totalInsulinPerDay,
        lastSiteChangeTreatment,
        lastSync,
        pumpAlarms
      );
      if (netPumpInsulin) {
        deviceStatus.reservoir = netPumpInsulin;
      }
    }
    
    devicestatus.push(deviceStatus);
  }

  if (pumpAlarms) {
    pumpAlarms.forEach(function (alarm) {
      var f_date = moment(alarm.pumpTimestamp);
      var alarmStatus = {
        created_at: new Date(f_date + timestampDelta).toISOString(),
        device: alarm.pumpName || 'Insulet Omnipod® 5 System',
        alarm: alarm.value
      };
      devicestatus.push(alarmStatus);
    });
    console.log('pumpAlarms processed:', pumpAlarms.length);
  }

  console.log('GLOOKO processing complete, returning', treatments.length, 'treatments', 'and', devicestatus.length, 'devicestatus records');
  // console.log(treatments);
  console.log(JSON.stringify(devicestatus, null, 2));
  return { treatments, devicestatus };
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;

/*
*****************************************************************
* Standalone run args
*****************************************************************
*/ 

var fs = require('fs');
var path = require('path');

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
  var treatments = await generate_nightscout_treatments(batch, args.offset);
  var output = JSON.stringify(treatments, null, 2);

  if (args.output) {
    var outputPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.log('Wrote treatments to', outputPath);
    return 0;
  }

  process.stdout.write(output + '\n');
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
