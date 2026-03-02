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
  var lastPumpSyncTimestamp = batch.lastPumpSyncTimestamp;
  var data = batch.results;
  return {
    foods: array_from_endpoint(data, 'Foods', 'foods'),
    insulins: array_from_endpoint(data, 'Insulins', 'insulins'),
    normalBoluses: array_from_endpoint(data, 'Pump Bolus', 'normalBoluses'),
    scheduledBasals: array_from_endpoint(data,'Pump Basal', 'scheduledBasals'),
    reservoirChange: objects_from_reservoir_change(data, 'Reservoir Change'),
    dailyInsulinTotals: objects_from_daily_totals(data, 'Insulin Per Day'),
    lastSync: lastPumpSyncTimestamp
  }  
}

function generate_nightscout_treatments(batch, timestampDelta) {
  inputBatch = assign_objects(batch);
  
  const foods = inputBatch.foods;
  const insulins = inputBatch.insulins;
  const pumpBoluses = inputBatch.normalBoluses;
  const scheduledBasals = inputBatch.scheduledBasals;
  const reservoirChange = inputBatch.reservoirChange;
  const totalInsulinPerDay = inputBatch.dailyInsulinTotals;
  const lastSync = inputBatch.lastSync;
  
  console.log("FOODS  ", foods);
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

      InsulinPerDay = totalInsulinPerDay.map(function (entry) {
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

      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Meal Bolus';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.insulin = element.insulinDelivered;
      treatment.carbs = element.carbsInput;
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
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

  if (InsulinPerDay || lastSync) {
    var deviceStatus = {
      created_at: lastSync || new Date().toISOString(),
      device: 'Omnipod 5',
      connect: {}
    };
    if (lastSync) {
      deviceStatus.connect.lastSync = lastSync;
    }
    if (InsulinPerDay) {
      deviceStatus.connect.totalInsulinPerDay = totalInsulinPerDay;
    }

    devicestatus.push(deviceStatus);
  }

  console.log('GLOOKO processing complete, returning', treatments.length, 'treatments', 'and', devicestatus.length, 'devicestatus records');
  console.log(devicestatus);
  return { treatments, devicestatus };
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
