

var moment = require('moment');
var fs = require('fs');
var path = require('path');


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
  var resChange = data?.series.reservoirChange;

  if (Array.isArray(resChange)) {
    return resChange.map(function (item) {
      var epochSeconds = Number(item.x);
      return Object.assign({
        epochSeconds: Number.isFinite(epochSeconds) ? epochSeconds : undefined,
        timestamp:
          item.timestamp ||
          (Number.isFinite(epochSeconds)
            ? new Date(epochSeconds * 1000).toISOString()
            : undefined),
      }, item);
    });
  }

  if (!resChange || typeof resChange !== 'object' || Array.isArray(resChange)) {
    return undefined;
  }

  return Object.keys(resChange)
    .sort()
    .map(function (epochSeconds) {
      return Object.assign({
        epochSeconds: Number(epochSeconds),
        timestamp: new Date(Number(epochSeconds) * 1000).toISOString(),
      }, resChange[epochSeconds]);
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
    .map(function (epochSeconds) {
      return Object.assign({
        epochSeconds: Number(epochSeconds),
        timestamp: new Date(Number(epochSeconds) * 1000).toISOString(),
      }, dayTotals[epochSeconds]);
    });
}

function calculate_daily_pump_insulin_deltas(dayTotals) {
  if (!Array.isArray(dayTotals)) {
    return [];
  }

  var sortedTotals = dayTotals
    .slice()
    .sort(function (a, b) {
      return Number(a?.epochSeconds || 0) - Number(b?.epochSeconds || 0);
    });

  var previousTotal;

  return sortedTotals
    .map(function (dayTotal) {
      var currentTotal = Number(dayTotal?.totalPumpInsulinPerDay);
      if (!Number.isFinite(currentTotal)) {
        return null;
      }

      var delta =
        Number.isFinite(previousTotal) ? Number((currentTotal - previousTotal).toFixed(2)) : null;

      previousTotal = currentTotal;

      return Object.assign({}, dayTotal, {
        pumpInsulinDelta: delta,
      });
    })
    .filter(Boolean);
}

function objects_from_settings(results, endpointName) {
  var endpoint = results[endpointName] || {};
  var data = endpoint.data || {};
  var devices = data.devices;

  if (!devices) {
    return undefined;
  }

  var deviceList = Array.isArray(devices) ? devices : Object.values(devices);

  var omnipodDevice = deviceList.find(function (device) {
    return device?.displayName === 'Insulet Omnipod® 5 System';
  });

  return omnipodDevice?.lastSyncTimestamp;
}


function with_integration_summary(batch) {
  var inputBatch = batch || {};
  var hasBatchData =
    inputBatch.foods ||
    inputBatch.insulins ||
    inputBatch.normalBoluses ||
    inputBatch.scheduledBasals ||
    inputBatch.reservoirChange ||
    inputBatch.dailyInsulinTotals;

  if (hasBatchData) {
    return inputBatch;
  }

  var summaryPath = path.resolve(process.cwd(), 'glooko-integration-summary.json');
  if (!fs.existsSync(summaryPath)) {
    return inputBatch;
  }

  try {
    var summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    var results = (summary?.results) || {};
    console.log('GLOOKO loading batch data from', summaryPath);

    return Object.assign({}, inputBatch, {
      foods: inputBatch.foods || array_from_endpoint(results, 'Foods', 'foods'),
      insulins:
        inputBatch.insulins || array_from_endpoint(results, 'Insulins', 'insulins'),
      normalBoluses:
        inputBatch.normalBoluses ||
        array_from_endpoint(results, 'Pump Bolus', 'normalBoluses'),
      scheduledBasals:
        inputBatch.scheduledBasals ||
        array_from_endpoint(results, 'Pump Basal', 'scheduledBasals'),
      // pumpSettings:
      //   inputBatch.pumpSettings ||
      //   array_from_endpoint(results, 'Pump Settings', 'pumpSettings'),
      reservoirChange:
        inputBatch.reservoirChange ||
        objects_from_reservoir_change(results, 'Reservoir Change'),
      dailyInsulinTotals:
        inputBatch.dailyInsulinTotals ||
        objects_from_daily_totals(results, 'Insulin Per Day'),
      lastSync:
        // inputBatch.lastSync ||
        objects_from_settings(results, 'Last Sync')
    });
  } catch (err) {
    console.warn('GLOOKO failed to parse integration summary:', err.message);
    return inputBatch;
  }
}

function generate_nightscout_treatments(batch, timestampDelta) {
  batch = with_integration_summary(batch);

  //   From index.js: original endpoints plus reservoir change and insulin per day from V3 API
  //   { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
  //   { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
  //   { name: 'Pump Settings', url: '/api/v2/pumps/settings', requiresPatient: false },
  //   { name: 'Pump Bolus', url: '/api/v2/pumps/normal_boluses', requiresPatient: false },
  //   { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
  //   { name: 'CGM Readings', url: '/api/v2/cgm/readings', requiresPatient: false },
  //   { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
  //   { name: 'Insulin Per Day', url: '/api/v3/graph/data', requiresPatient: true, series: 'totalInsulinPerDay' }

  
  
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const scheduledBasals = batch.scheduledBasals;
  const reservoirChange = batch.reservoirChange;
  const totalInsulinPerDay = batch.dailyInsulinTotals;
  const totalPumpInsulinPerDayDeltas = calculate_daily_pump_insulin_deltas(totalInsulinPerDay);
  // const pumpSettings = batch.settings;
  const lastSync = batch.lastSync;
  
  console.log("FOODS  ",foods);
  console.log("INSULINS  ", insulins );
  console.log("BOLUS  ", pumpBoluses );
  console.log("BASAL  ", scheduledBasals);
  console.log("RESERVOIR CHANGE  ", reservoirChange );
  console.log("DAY TOTALS  ", totalInsulinPerDay );
  // console.log("SETTINGS  ", pumpSettings );
  console.log("LAST SYNC  ", lastSync );


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

  var devicestatus = [];
  if (totalInsulinPerDay && Array.isArray(totalInsulinPerDay)) {
    totalInsulinPerDay.forEach(function (element) {
      var totalPumpInsulinPerDay = Number(element?.totalPumpInsulinPerDay);
      if (!Number.isFinite(totalPumpInsulinPerDay)) {
        return;
      }

      var created_at = new Date(new Date(element.timestamp).getTime() + timestampDelta).toISOString();
      devicestatus.push({
        created_at: created_at,
        device: 'Glooko',
        pump: {
          reservoir: totalPumpInsulinPerDay,
        },
      });
    });
  }

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments', devicestatus.length, 'devicestatus');

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
    console.error('Missing required --input argument');
    print_help();
    return 1;
  }

  if (Number.isNaN(args.offset)) {
    console.error('Invalid --offset value. Expected a number of milliseconds.');
    return 1;
  }

  var batch = read_json_file(args.input);
  var result = generate_nightscout_treatments(batch, args.offset);
  var output = JSON.stringify(result.treatments, null, 2);

  if (args.output) {
    var outputPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.log('Wrote', result.treatments.length, 'treatments to', outputPath);
    return 0;
  }

  process.stdout.write(output + '\n');
  return 0;
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
