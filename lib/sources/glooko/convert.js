var moment = require('moment');

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

  if (!siteChange || typeof siteChange !== 'object' || Array.isArray(siteChange)) {
    return undefined;
  }

  return Object.keys(siteChange)
    .sort()
    .map(function (epochSeconds) {
      return Object.assign({
        epochSeconds: Number(epochSeconds),
        timestamp: new Date(Number(epochSeconds) * 1000).toISOString(),
      }, siteChange[epochSeconds]);
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

function lastSyncTimestamp(results, endpointName) {
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

  try {
    // var summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    // var results = (summary?.results) || {};
    // console.log('GLOOKO loading batch data from', summaryPath);

    return Object.assign({}, inputBatch, {
      foods: inputBatch.foods || array_from_endpoint(batch, 'Foods', 'foods'),
      insulins:
        inputBatch.insulins || array_from_endpoint(batch, 'Insulins', 'insulins'),
      normalBoluses:
        inputBatch.normalBoluses ||
        array_from_endpoint(batch, 'Pump Bolus', 'normalBoluses'),
      scheduledBasals:
        inputBatch.scheduledBasals ||
        array_from_endpoint(batch, 'Pump Basal', 'scheduledBasals'),
      // pumpSettings:
      //   inputBatch.pumpSettings ||
      //   array_from_endpoint(batch, 'Pump Settings', 'pumpSettings'),
      reservoirChange:
        inputBatch.reservoirChange ||
        objects_from_reservoir_change(batch, 'Reservoir Change'),
      dailyInsulinTotals:
        inputBatch.dailyInsulinTotals ||
        objects_from_daily_totals(batch, 'Insulin Per Day'),
      lastSync:
        // inputBatch.lastSync ||
        lastSyncTimestamp(batch, 'Last Sync')
    });
  } catch (err) {
    console.warn('GLOOKO failed to parse input:', err.message);
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

  console.log(JSON.stringify(batch));
  
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const scheduledBasals = batch.scheduledBasals;
  const reservoirChange = batch.reservoirChange;
  let totalInsulinPerDay = batch.dailyInsulinTotals;
  // const pumpSettings = batch.settings;
  const lastSync = batch.lastSync;
  
  // Collate devicestatus from last sync and total insulin
  // add last sync timestamp to current day's values to enable
  // a running total of insulin per day
  var devicestatus = [];
  
  if (totalInsulinPerDay && lastSync) {
    var lastSyncMoment = moment(lastSync);

    if (lastSyncMoment.isValid()) {
      var lastSyncDate = lastSyncMoment.format('YYYY/MM/DD');
      var lastSyncEpochSeconds = Math.floor(lastSyncMoment.valueOf() / 1000);

      totalInsulinPerDay = totalInsulinPerDay.map(function (entry) {
        var entryMoment = moment(
          entry.timestamp ||
          (Number.isFinite(entry.epochSeconds)
            ? new Date(entry.epochSeconds * 1000).toISOString()
            : undefined)
        );

        if (!entryMoment.isValid()) {
          return entry;
        }

        if (entryMoment.format('YYYY/MM/DD') === lastSyncDate) {
          return Object.assign({}, entry, {
            epochSeconds: lastSyncEpochSeconds,
            timestamp: lastSync,
          });
        }

        return entry;
      });
    }
  }
  
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
        (Number.isFinite(element.epochSeconds)
          ? new Date(element.epochSeconds * 1000).toISOString()
          : undefined);

      if (!baseTimestamp) {
        return;
      }

      var f_date = moment(baseTimestamp);

      var siteChangeTreatment = {};
      siteChangeTreatment.eventType = 'Pump Site Change';
      siteChangeTreatment.created_at = new Date(f_date + timestampDelta).toISOString();
      siteChangeTreatment.notes = JSON.stringify(element);

      var cartridgeChangeTreatment = {};
      cartridgeChangeTreatment.eventType = 'Insulin Cartridge Change';
      cartridgeChangeTreatment.created_at = new Date(f_date + timestampDelta).toISOString();
      cartridgeChangeTreatment.notes = JSON.stringify(element);

      treatments.push(siteChangeTreatment);
      treatments.push(cartridgeChangeTreatment);
    });
  }

  if (totalInsulinPerDay || lastSync) {
    var deviceStatus = {
      created_at: lastSync || new Date().toISOString(),
      device: 'nightscout-connect://glooko',
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

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments', 'and', devicestatus.length, 'devicestatus records');
  return { treatments, devicestatus };
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
