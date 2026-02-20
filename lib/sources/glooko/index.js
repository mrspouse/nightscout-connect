/*
 * https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
 * Glooko integration with Puppeteer-based authentication
 * Authors:
 * Jeremy Pollock
 * Jon Fawcett
 * and others.
 */

var url = require("url");
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
var helper = require("./convert");

/** @type {Object<string, string>} */
_known_servers = {
  default: "api.glooko.com",
  development: "api.glooko.work",
  production: "externalapi.glooko.com",
  eu: "eu.api.glooko.com",
};

var Defaults = {
  applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  lastGuid: "1e0c094e-1e54-4a4f-8e6a-f94484b53789",
  login: "/api/v2/users/sign_in",
  mime: "application/json",
  LatestFoods: "/api/v2/foods",
  LatestInsulins: "/api/v2/insulins",
  LatestPumpBasals: "/api/v2/pumps/scheduled_basals",
  LatestPumpBolus: "/api/v2/pumps/normal_boluses",
  LatestCGMReadings: "/api/v2/cgm/readings",
  PumpSettings: "/api/v2/pumps/settings",
  v3API: "/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=automaticBolus&series[]=basalBarAutomated&series[]=basalBarAutomatedMax&series[]=basalBarAutomatedSuspend&series[]=basalLabels&series[]=basalModulation&series[]=bgAbove400&series[]=bgAbove400Manual&series[]=bgHigh&series[]=bgHighManual&series[]=bgLow&series[]=bgLowManual&series[]=bgNormal&series[]=bgNormalManual&series[]=bgTargets&series[]=carbNonManual&series[]=cgmCalibrationHigh&series[]=cgmCalibrationLow&series[]=cgmCalibrationNormal&series[]=cgmHigh&series[]=cgmLow&series[]=cgmNormal&series[]=deliveredBolus&series[]=deliveredBolus&series[]=extendedBolusStep&series[]=extendedBolusStep&series[]=gkCarb&series[]=gkInsulin&series[]=gkInsulin&series[]=gkInsulinBasal&series[]=gkInsulinBolus&series[]=gkInsulinOther&series[]=gkInsulinPremixed&series[]=injectionBolus&series[]=injectionBolus&series[]=interruptedBolus&series[]=interruptedBolus&series[]=lgsPlgs&series[]=overrideAboveBolus&series[]=overrideAboveBolus&series[]=overrideBelowBolus&series[]=overrideBelowBolus&series[]=pumpAdvisoryAlert&series[]=pumpAlarm&series[]=pumpBasaliqAutomaticMode&series[]=pumpBasaliqManualMode&series[]=pumpCamapsAutomaticMode&series[]=pumpCamapsBluetoothTurnedOffMode&series[]=pumpCamapsBoostMode&series[]=pumpCamapsDailyTotalInsulinExceededMode&series[]=pumpCamapsDepoweredMode&series[]=pumpCamapsEaseOffMode&series[]=pumpCamapsExtendedBolusNotAllowedMode&series[]=pumpCamapsManualMode&series[]=pumpCamapsNoCgmMode&series[]=pumpCamapsNoPumpConnectivityMode&series[]=pumpCamapsPumpDeliverySuspendedMode&series[]=pumpCamapsUnableToProceedMode&series[]=pumpControliqAutomaticMode&series[]=pumpControliqExerciseMode&series[]=pumpControliqManualMode&series[]=pumpControliqSleepMode&series[]=pumpGenericAutomaticMode&series[]=pumpGenericManualMode&series[]=pumpOp5AutomaticMode&series[]=pumpOp5HypoprotectMode&series[]=pumpOp5LimitedMode&series[]=pumpOp5ManualMode&series[]=reservoirChange&series[]=scheduledBasal&series[]=setSiteChange&series[]=suggestedBolus&series[]=suggestedBolus&series[]=suspendBasal&series[]=temporaryBasal&series[]=unusedScheduledBasal&locale=en-GB",
};

/**
 * @param {object} spec
 * @param {string} [spec.glookoServer]
 * @param {string} [spec.glookoEnv]
 * @returns {string}
 */
function base_for(spec) {
  var server = spec.glookoServer
    ? spec.glookoServer
    : _known_servers[spec.glookoEnv || "default"];
  var base = {
    protocol: "https",
    host: server,
  };
  return url.format(base);
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.glookoServer]
 * @param {string} [opts.glookoEnv]
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @param {number} [opts.glookoTimezoneOffset]
 * @param {import('axios').AxiosStatic} axiosLib
 * @returns {object}
 */
function glookoSource(opts, axiosLib) {
  var baseURL = opts.baseURL;
  const referrer = `https://eu.my.glooko.com`;
  const webUrl = opts.webUrl || referrer;
  const apiUrl = baseURL;

  var default_headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    Referer: `${referrer}/`,
    Origin: `${referrer}`,
    Connection: "keep-alive",
    "Accept-Language": "en-GB,en;q=0.9",
  };

  var http = axiosLib.create({ baseURL, headers: default_headers });

  var impl = {
    authFromCredentials() {
      return glookoPuppeteerAuth(opts, webUrl, apiUrl);
    },

    /**
     * @param {{cookies: string, user: any, patientId: string}} auth
     * @returns {Promise<{cookies: string, user: any, patientId: string}>}
     */
    sessionFromAuth(auth) {
      return Promise.resolve(auth);
    },

    /**
     * @param {{cookies: string, user: any, patientId: string}} session
     * @param {{entries: Date}} last_known
     * @returns {Promise<object>}
     */
    async dataFromSesssion(session, last_known) {
      var two_days_ago = new Date().getTime() - 2 * 24 * 60 * 60 * 1000;
      var last_mills = Math.max(
        two_days_ago,
        last_known && last_known.entries
          ? last_known.entries.getTime()
          : two_days_ago
      );

      function constructUrl(endpoint, startDate, endDate) {
        return endpoint +
          "?patient=" + session.patientId +
          "&startDate=" + startDate +
          "&endDate=" + endDate;
      }

      const startDate = new Date(new Date(two_days_ago).setHours(0, 0, 0, 0)).toISOString();
      const endDate = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

      const urlsToFetch = [
        Defaults.LatestFoods,
        Defaults.LatestInsulins,
        Defaults.LatestPumpBasals,
        Defaults.LatestPumpBolus,
        Defaults.LatestCGMReadings,
        Defaults.PumpSettings
      ].map(endpoint => constructUrl(endpoint, startDate, endDate));

      function fetcher(endpoint) {
        var headers = Object.assign({}, default_headers);
        headers["Cookie"] = session.cookies;
        headers["Host"] = opts.glookoServer;
        headers["Sec-Fetch-Dest"] = "empty";
        headers["Sec-Fetch-Mode"] = "cors";
        headers["Sec-Fetch-Site"] = "same-site";
        console.log("GLOOKO FETCHER LOADING", endpoint);
        return http.get(endpoint, { headers }).then((resp) => resp.data);
      }

      const results = await Promise.all(urlsToFetch.map(fetcher));

      return {
        food: results[0].foods || [],
        insulins: results[1].insulins || [],
        scheduledBasals: results[2].scheduledBasals || [],
        normalBoluses: results[3].normalBoluses || [],
        readings: results[4].readings || [],
        pumpSettings: results[5]
      };
    },

    align_to_glucose() {
      // TODO
    },

    /**
     * @param {object} batch
     * @returns {{entries: any[], treatments: any[]}}
     */
    transformData(batch) {
      console.log("GLOOKO passing batch for transforming");
      var treatments = helper.generate_nightscout_treatments(
        batch,
        opts.glookoTimezoneOffset
      );
      return { entries: [], treatments };
    },
  };

  function tracker_for() {
    var AxiosTracer = require("../../trace-axios");
    var tracker = AxiosTracer(http);
    return tracker;
  }

  /**
   * @param {object} builder
   * @returns {object}
   */
  function generate_driver(builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 1000 * 60 * 60 * 24 * 1 - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      },
    });

    builder.register_loop("Glooko", {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformData,
        backoff: {
          interval_ms: 2.5 * 60 * 1000,
        },
        maxRetries: 1,
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        interval_ms: 2.5 * 60 * 1000,
      },
    });
    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;
}

/**
 * Puppeteer-based authentication for Glooko
 * @param {object} opts
 * @param {string} webUrl
 * @param {string} apiUrl
 * @returns {Promise<{cookies: string, user: any, patientId: string}>}
 */
async function glookoPuppeteerAuth(opts, webUrl, apiUrl) {
  let browser;

  try {
    console.log('🔐 Starting Glooko Puppeteer-based authentication');
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('📋 Navigating to Glooko login page');
    await page.goto(webUrl + '/users/sign_in?locale=en', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    console.log('📋 Filling login form');
    await page.type('input[name="user[email]"]', opts.glookoEmail);
    await page.type('input[name="user[password]"]', opts.glookoPassword);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
      page.click('input[type="submit"]')
    ]);
    
    console.log('✅ Login successful');
    
    // Wait for JavaScript to execute
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const patientId = await page.evaluate(() => {
      return window.patient || 
             window.current_user_glooko_code || 
             window.patientId;
    });
    
    if (!patientId) {
      throw new Error('Could not extract patient ID from page');
    }
    
    console.log(`✅ Patient ID extracted: ${patientId}`);
    
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    console.log(`✅ Extracted ${cookies.length} session cookies`);
    
    await browser.close();
    browser = null;

    return {
      cookies: cookieHeader,
      user: { patientId },
      patientId
    };

  } catch (error) {
    console.error('❌ Glooko Puppeteer authentication failed:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * @param {object} input
 * @param {string} [input.glookoEnv]
 * @param {string} [input.glookoServer]
 * @param {string} input.glookoEmail
 * @param {string} input.glookoPassword
 * @param {number} [input.glookoTimezoneOffset]
 * @returns {{ok: boolean, errors: {desc: string, err: Error}[], config: object}}
 */
glookoSource.validate = function validate_inputs(input) {
  var ok = false;
  var baseURL = base_for(input);

  const offset = !isNaN(input.glookoTimezoneOffset)
    ? input.glookoTimezoneOffset * -60 * 60 * 1000
    : 0;
  console.log("GLOOKO using ms offset:", offset, input.glookoTimezoneOffset);

  var config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
    glookoTimezoneOffset: offset,
    baseURL,
    webUrl: input.webUrl || 'https://eu.my.glooko.com'
  };
  var errors = [];
  if (!config.glookoEmail) {
    errors.push({
      desc: "The Glooko User Login Email is required.. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.",
      err: new Error("CONNECT_GLOOKO_EMAIL"),
    });
  }
  if (!config.glookoPassword) {
    errors.push({
      desc: "Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.",
      err: new Error("CONNECT_GLOOKO_PASSWORD"),
    });
  }
  ok = errors.length == 0;
  config.kind = ok ? "glooko" : "disabled";
  return { ok, errors, config };
};

module.exports = glookoSource;