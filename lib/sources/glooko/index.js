/*
 *
 * https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
 * Authors:
 * Jeremy Pollock
 * https://github.com/jpollock
 * Jon Fawcett
 * and others.
 * 
 * Enhanced with Puppeteer-based browser authentication
 * https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
 */

var url = require("url");
const { CookieJar } = require("tough-cookie");
const { glookoConnect } = require('./glooko-login.js');
const fs = require('fs');

var helper = require("./convert");

// /** @type {Object<string, string>} */
_known_servers = {
  default: "api.glooko.com",
  development: "api.glooko.work",
  production: "externalapi.glooko.com",
  eu: "eu.api.glooko.com",
};

var Defaults = {
  applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  lastGuid: "1e0c094e-1e54-4a4f-8e6a-f94484b53789", // hardcoded, random guid; no Glooko docs to explain need for param or why bad data works
  login: "/api/v2/users/sign_in",
  mime: "application/json",
  // Legacy endpoints
  LatestFoods: "/api/v2/foods",
  LatestInsulins: "/api/v2/insulins",
  LatestPumpBasals: "/api/v2/pumps/scheduled_basals",
  LatestPumpBolus: "/api/v2/pumps/normal_boluses",
  LatestCGMReadings: "/api/v2/cgm/readings",
  PumpSettings: "/api/v2/pumps/settings"
}

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
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @returns {object}
 */
function login_payload(opts) {
  var body = {
    userLogin: {
      email: opts.glookoEmail,
      password: opts.glookoPassword,
    },
    "deviceInformation": {
        "applicationType": "logbook",
        "os": "android",
        "osVersion": "33"
     }
  };
  return body;
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.con]
 * @param {string} [opts.glookoEnv]
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @param {number} [opts.glookoTimezoneOffset]
 * @param {import('axios').AxiosStatic} axios
 * @returns {object}
 */
function glookoSource(opts, axios) {
  var baseURL = opts.baseURL; // This is likely eu.api.glooko.com, will be overridden for login
  const referrer = `https://eu.my.glooko.com`
  var default_headers = {
    // These headers were for the JSON API. Some might be reusable or need adjustment.
    // "Content-Type": Defaults.mime, // This will be overridden for web form login
    Accept: "application/json, text/plain, */*", // May need adjustment for web login expectations
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15", // Consider using a common browser User-Agent
    Referer: `${referrer}/`,
    Origin: `${referrer}`,
    Connection: "keep-alive",
    "Accept-Language": "en-GB,en;q=0.9",
  };

  var http = axios.create({ baseURL, headers: default_headers }); // This http instance is used for data fetching

  var impl = {
    async authFromCredentials() {
      },

    /**
     * @param {{cookies: string, user: any}} auth
     * @returns {Promise<{cookies: string, user: any}>}
     */
    sessionFromAuth(auth) {
      return Promise.resolve(auth);
    },
  
    /**
     * @param {{cookies: string, user: any}} session
     * @param {{entries: Date}} last_known
     * @returns {Promise<object>}
     */
    async dataFromSesssion(session, last_known) {
      // var two_days_ago = new Date().getTime() - 2 * 24 * 60 * 60 * 1000;
      // var last_mills = Math.max(
      //   two_days_ago,
      //   last_known && last_known.entries
      //     ? last_known.entries.getTime()
      //     : two_days_ago
      // );
      // var maxCount = Math.ceil(
      //   (new Date().getTime() - last_mills) / (1000 * 60 * 5)
      // );
      // var lastUpdatedAt = new Date(two_days_ago);
      // var params = {
      //   lastGuid: Defaults.lastGuid,
      //   lastUpdatedAt,
      //   limit: maxCount,
      // };

      // const { glookoCode } = session.user.userLogin;

      // /**
      //  * @param {string} endpoint
      //  * @returns {Promise<any>}
      //  */
      // function fetcher(endpoint) {
      //   var headers = default_headers;
      //   headers["Cookie"] = session.cookies;
      //   headers["Host"] = opts.glookoServer;
      //   headers["Sec-Fetch-Dest"] = "empty";
      //   headers["Sec-Fetch-Mode"] = "cors";
      //   headers["Sec-Fetch-Site"] = "same-site";
      //   console.log("FETCHER HEADERS   ", headers, params);
      //   console.log("GLOOKO FETCHER LOADING", endpoint);
      //   return http
      //     .get(endpoint, { headers, params })
      //     .then((resp) => resp.data);
      // }

      //       /**
      //  * @param {string} endpoint
      //  * @returns {string} - ?patient=orange-waywood-8651&startDate=2020-01-08T06:07:00.000Z&endDate=2020-01-09T06:07:00.000Z
      //  */
      // function constructUrl(endpoint, startDate, endDate) {

      //   return endpoint +
      //   "?patient=" +
      //   session.user.userLogin.glookoCode +
      //   "&startDate=" +
      //   startDate +
      //   "&endDate=" +
      //   endDate;
      // }

      // const startDate = new Date(new Date(two_days_ago).setHours(0, 0, 0, 0)).toISOString();
      // const endDate = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

      // const urlsToFetch = [
      //   Defaults.LatestFoods,
      //   Defaults.LatestInsulins,
      //   Defaults.LatestPumpBasals,
      //   Defaults.LatestPumpBolus,
      //   Defaults.LatestCGMReadings,
      //   Defaults.PumpSettings
      // ].map(endpoint => constructUrl(endpoint, startDate, endDate));

      // const results = await Promise.all(urlsToFetch.map(fetcher));
      const results = await glookoConnect(opts);
      // console.log(results);

      return {
        // food: results[0].foods,
        // insulins: results[1].insulins,
        // scheduledBasals: results[2].scheduledBasals,
        // normalBoluses: results[3].normalBoluses,
        // readings: results[4].readings,
        // pumpSettings: results[5]
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
      // TODO
      console.log("GLOOKO passing batch for transforming");
      
      var result = helper.generate_nightscout_treatments(
        batch,
        opts.glookoTimezoneOffset
      );
      return { entries: [], treatments: result.treatments, devicestatus: result.devicestatus || [] };
    },
  };
  function tracker_for() {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
    var AxiosTracer = require("../../trace-axios");
    var tracker = AxiosTracer(apiHttp);
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
      // refresh: impl.refreshSession,
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
          // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000,
        },
        // only try 3 times to get data
        maxRetries: 1,
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000,
      },
    });
    return builder;
  }
  impl.generate_driver = generate_driver;
  return impl;
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