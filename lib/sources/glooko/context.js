/**
 * Nightscout API helper for the Glooko convert module.
 *
 * Centralises every HTTP call that convert.js previously made inline,
 * so the converter itself can stay a pure data transformer.
 *
 * Usage:
 *   var ns = createNightscoutHelper({ url, token });
 *   var ctx = await ns.buildContext({ hasReservoirChanges, hasPumpAlarms });
 *   // ctx.existingSiteChanges, ctx.existingAlarms, ctx.fetchBaselineTotal
 */

var axios = require('axios');
const moment = require('moment');
const insulinCalc = require('./insulin-calc');

var REQUEST_TIMEOUT = 15000;

/**
 * @param {{ url: string, token: string }} config
 */
function createNightscoutHelper(config) {
  var baseUrl = config.url;
  var accessToken = config.token;

  /**
   * Exchange the access token for a short-lived JWT.
   */
  async function getJwt() {
    var res = await axios.get(
      baseUrl + '/api/v2/authorization/request/' + accessToken,
      { timeout: REQUEST_TIMEOUT }
    );
    return res.data.token;
  }

  /**
   * Fetch existing Pump Site Change treatments from Nightscout.
   */
  async function fetchExistingSiteChanges(jwt) {
    var res = await axios.get(
      baseUrl + '/api/v3/treatments?eventType=Pump%20Site%20Change&sort$desc=created_at&limit=200',
      { headers: { 'Authorization': 'Bearer ' + jwt }, timeout: REQUEST_TIMEOUT }
    );
    var data = res.data;
    return (Array.isArray(data) ? data : (data?.result || [data])).filter(Boolean);
  }

  /**
   * Fetch existing Sensor Change treatments from Nightscout.
   */
  async function fetchExistingSensorChanges(jwt) {
    var res = await axios.get(
      baseUrl + '/api/v3/treatments?eventType=Sensor%20Change&sort$desc=created_at&limit=200',
      { headers: { 'Authorization': 'Bearer ' + jwt }, timeout: REQUEST_TIMEOUT }
    );
    var data = res.data;
    return (Array.isArray(data) ? data : (data?.result || [data])).filter(Boolean);
  }

  /**
   * Fetch existing Daily Total treatments from Nightscout.
   */
  async function fetchExistingDailyTreatment(jwt, eventType) {
    var res = await axios.get(
      baseUrl + '/api/v3/treatments?eventType=' + encodeURIComponent(eventType) + '&sort$desc=created_at&limit=200',
      { headers: { 'Authorization': 'Bearer ' + jwt }, timeout: REQUEST_TIMEOUT }
    );
    var data = res.data;
    return (Array.isArray(data) ? data : (data?.result || [data])).filter(Boolean);
  }

  /**
   * Fetch existing devicestatus alarm records from Nightscout.
   */
  async function fetchExistingAlarms(jwt) {
    var res = await axios.get(
      baseUrl + '/api/v3/devicestatus?sort$desc=created_at&limit=1000',
      { headers: { 'Authorization': 'Bearer ' + jwt }, timeout: REQUEST_TIMEOUT }
    );
    var data = res.data;
    return (Array.isArray(data) ? data : (data?.result || [data])).filter(function (t) {
      return t && t.alarm;
    });
  }

  /**
   * Build the context object that the converter needs.
   *
   * @param {{ hasReservoirChanges: boolean, hasPumpAlarms: boolean, hasDailyTotals: boolean }} options
   * @returns {Promise<{ existingSiteChanges: Array, existingAlarms: Array, existingDailyBasal: Array, existingDailyBolus: Array, fetchBaselineTotal: Function }>}
   */
  async function buildContext(options) {
    var context = {
      existingSiteChanges: [],
      existingAlarms: [],
      existingSensorChanges: [],
      existingDailyBasal: [],
      existingDailyBolus: [],
      fetchBaselineTotal: fetchBaselineTotal,
    };

    var needsSiteChanges = options && options.hasReservoirChanges;
    var needsAlarms = options && options.hasPumpAlarms;
    var needsCgmChanges = options && options.hasCgmChanges;
    var needsDailyTotals = options && options.hasDailyTotals;

    if (!needsSiteChanges && !needsAlarms && !needsCgmChanges && !needsDailyTotals) {
      return context;
    }

    try {
      var jwt = await getJwt();
      if (!jwt) {
        console.error('Failed to obtain JWT token for context');
        return context;
      }

      if (needsSiteChanges) {
        context.existingSiteChanges = await fetchExistingSiteChanges(jwt);
      }
      if (needsAlarms) {
        context.existingAlarms = await fetchExistingAlarms(jwt);
      }
      if (options && options.hasCgmChanges) {
        context.existingSensorChanges = await fetchExistingSensorChanges(jwt);
      }
      if (needsDailyTotals) {
        context.existingDailyBasal = await fetchExistingDailyTreatment(jwt, 'Daily Basal');
        context.existingDailyBolus = await fetchExistingDailyTreatment(jwt, 'Daily Bolus');
      }
    } catch (e) {
      console.error('Failed to fetch existing records for sync preservation:', e.message);
    }

    return context;
  }

  /**
   * Fetch the insulin baseline total from the devicestatus collection.
   * Called mid-transform once lastSiteChangeTreatment is known.
   *
   * @param {string} lastSiteChangeTreatment  ISO timestamp of the last site change
   * @returns {Promise<number|undefined>}
   */
  async function fetchBaselineTotal(lastSiteChangeTreatment) {
    var siteChange = moment(lastSiteChangeTreatment).toISOString();
    console.log('Last site change: ', siteChange);

    try {
      var jwt = await getJwt();
      if (!jwt) {
        console.error('Failed to obtain JWT token');
        return undefined;
      }

      var baselineRes = await axios.get(
        baseUrl + '/api/v3/devicestatus?lastSiteChange=' + siteChange + '&limit=1000',
        { headers: { 'Authorization': 'Bearer ' + jwt }, timeout: REQUEST_TIMEOUT }
      );

      var data = baselineRes.data;
      var records = Array.isArray(data) ? data : (data?.result || []);
      records = records.filter(Boolean).sort(function(a, b) {
        return moment(a.created_at).valueOf() - moment(b.created_at).valueOf();
      });
      
      var baseline = records[0] || {};

      console.log('API Baseline: ', baseline);

      if (Number.isFinite(Number(baseline.totalPumpInsulinPerDay))) {
        return Number(baseline.totalPumpInsulinPerDay);
      }

      if (baseline.reservoir && Number.isFinite(Number(baseline.reservoir.baselineTotal))) {
        return Number(baseline.reservoir.baselineTotal);
      }

      var insulinPerDay = Array.isArray(baseline.InsulinPerDay) ? baseline.InsulinPerDay : [];
      if (insulinPerDay.length > 0) {
        var insulinTotal = insulinCalc.insulin_total_value(insulinPerDay[insulinPerDay.length - 1]);
        return Number.isFinite(insulinTotal) ? insulinTotal : undefined;
      }

      return undefined;
    } catch (error) {
      console.error('Error in fetchBaselineTotal:', error.message);
      return undefined;
    }
  }

  return { buildContext, fetchBaselineTotal };
}

module.exports = { createNightscoutHelper };
