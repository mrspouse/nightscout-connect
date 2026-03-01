#!/usr/bin/env node

var moment = require('moment');
// Add fs and path for input file
var fs = require('fs');
var path = require('path');
//

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
  var dayTotals = data.series?.dailyInsulinTotals;

  if (!dayTotals || typeof dayTotals !== 'object' || Array.isArray(dayTotals)) {
    return undefined;
  }

  return Object.keys(dayTotals)
    .sort()
    .map(function (mills) {
      return Object.assign({
        mills: Number(mills),
        timestamp: new Date(Number(mills) * 1000).toISOString(),
      }, dayTotals[mills]);
    });
}

function assign_objects(batch) {
  var data = batch;

  if (!data || Object.keys(data).length === 0) {
    var summaryPath = path.resolve(
      process.cwd(),
      'glooko-integration-summary.json'
    );
    if (!fs.existsSync(summaryPath)) {
      return {};
    }

    try {
      var summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      data = summary.results || {};
      if (summary.lastPumpSyncTimestamp) {
        data.lastPumpSyncTimestamp = summary.lastPumpSyncTimestamp;
      }
      console.log('GLOOKO loading batch data from', summaryPath);
    } catch (err) {
      console.warn('Failed to parse input:', err.message);
      return {};
    }
  }

  data = data || {};
  return {
    foods: array_from_endpoint(data, 'Foods', 'foods'),
    insulins: array_from_endpoint(data, 'Insulins', 'insulins'),
    normalBoluses: array_from_endpoint(data, 'Pump Bolus', 'normalBoluses'),
    scheduledBasals: array_from_endpoint(
      data,
      'Pump Basal',
      'scheduledBasals'
    ),
    reservoirChange: objects_from_reservoir_change(data, 'Reservoir Change'),
    dailyInsulinTotals: objects_from_daily_totals(data, 'Insulin Per Day'),
    lastSync: data.lastPumpSyncTimestamp,
  };
}

function generate_nightscout_treatments(batch, timestampDelta) {
  batch = assign_objects(batch);
  
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const scheduledBasals = batch.scheduledBasals;
  const reservoirChange = batch.reservoirChange;
  const totalInsulinPerDay = batch.dailyInsulinTotals;
  const lastSync = batch.lastSync;
  
  console.log("FOODS  ",foods);
  console.log("INSULINS  ", insulins );
  console.log("BOLUS  ", pumpBoluses );
  console.log("BASAL  ", scheduledBasals);
  console.log("RESERVOIR CHANGE  ", reservoirChange );
  console.log("DAY TOTALS  ", totalInsulinPerDay );
  console.log("LAST SYNC  ", lastSync );

  // devicestatus entry from last sync and total insulin
  var devicestatus = [];
  
  if (totalInsulinPerDay && lastSync) {
    var lastSyncMoment = moment(lastSync);

    if (lastSyncMoment.isValid()) {
      var lastSyncDate = lastSyncMoment.format('YYYY/MM/DD');
      var lastSyncMills = Math.floor(lastSyncMoment.valueOf() / 1000);

      totalInsulinPerDay = totalInsulinPerDay.map(function (entry) {
        var entryMoment = moment(
          entry.timestamp ||
          (Number.isFinite(entry.mills)
            ? new Date(entry.mills * 1000).toISOString()
            : undefined)
        );

        if (!entryMoment.isValid()) {
          return entry;
        }

        if (entryMoment.format('YYYY/MM/DD') === lastSyncDate) {
          return Object.assign({}, entry, {
            mills: lastSyncMills,
            timestamp: lastSync,
          });
        }

        return entry;
      });
    }
  }

  var treatments = []
  
  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      //console.log(element);
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
        //treatment.eventTime = new Date(i_date).toISOString( );
        //treatment.eventTime = i_date.toISOString( );
        treatment.insulin = insulin.value;
        
        treatment.preBolus = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date ).toISOString( );
        //treatment.eventTime = new Date(f_date).toISOString( );
        //treatment.eventTime = f_date.toISOString( );
      }

      treatment.carbs = element.carbs;
      treatment.notes = JSON.stringify(element);
      
      treatments.push(treatment);
      //console.log(treatment)

    });    
  }

  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime() + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = foods.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      //console.log(result);
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString( );
        treatment.insulin = element.value;
        //treatment.eventTime = f_date.toISOString( );
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Meal Bolus';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.insulin = element.insulinDelivered;
      treatment.carbs = element.carbsInput;
      treatment.notes = JSON.stringify(element);
      //treatment.eventTime = f_date.toISOString( );
      treatments.push(treatment);
    })
  }

  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Temp Basal';
      treatment.created_at = new Date(f_date + timestampDelta).toISOString( );
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = element.duration / 60;
      treatment.notes = JSON.stringify(element);
      //treatment.eventTime = f_date.toISOString( );
      treatments.push(treatment);
    })
  }

 if (reservoirChange) {
    reservoirChange.forEach(function(element) {
      var baseTimestamp =
        element.timestamp ||
        (Number.isFinite(element.mills)
          ? new Date(element.mills * 1000).toISOString()
          : undefined);

      if (!baseTimestamp) {
        return;
      }

      var f_date = moment(baseTimestamp);

      var siteChangeTreatment = {};
      siteChangeTreatment.eventType = 'Pump Site Change';
      siteChangeTreatment.created_at = new Date(f_date + timestampDelta).toISOString();
      siteChangeTreatment.notes = JSON.stringify(element);

      treatments.push(siteChangeTreatment);
    });
  }

  if (totalInsulinPerDay || lastSync) {
    var deviceStatus = {
      created_at: lastSync || new Date().toISOString(),
      device: 'Omnipod 5',
      connect: {}
    };
    if (lastSync) {
      deviceStatus.connect.lastSync = lastSync;
    }
    if (totalInsulinPerDay) {
      deviceStatus.connect.totalInsulinPerDay = totalInsulinPerDay;
    }

    devicestatus.push(deviceStatus);
  }

  console.log('GLOOKO processing complete, returning', treatments.length, 'treatments', 'and', devicestatus.length, 'devicestatus records');
  console.log(devicestatus);
  return { treatments, devicestatus };
}

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

function run_cli(argv) {
  var args = parse_args(argv);

  if (args.help) {
    print_help();
    return 0;
  }

  if (!args.input) {
    args.input = 'glooko-integration-batch.json';
    return 0;
  }

if (!args.output) {
    args.output = 'output.json';
    return 0;
  }

  if (Number.isNaN(args.offset)) {
    console.error('Invalid --offset value. Expected a number of milliseconds.');
    return 1;
  }

  var batch = read_json_file(args.input);
  var treatments = generate_nightscout_treatments(batch, args.offset);
  var output = JSON.stringify(treatments, null, 2);

  if (args.output) {
    var outputPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.log('Wrote', treatments.length, 'treatments to', outputPath);
    return 0;
  }

  process.stdout.write(output + '\n');
  return 0;
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;

if (require.main === module) {
  process.exitCode = run_cli(process.argv.slice(2));
}
