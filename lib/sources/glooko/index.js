/*
 *
 * https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
 * Authors:
 * Jeremy Pollock
 * https://github.com/jpollock
 * Jon Fawcett
 * and others.
 * 
 * Enhanced with Playwright-based browser authentication to enable Glooko to re-sync with Omnipod 5
 * https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
 * 
 */

var url = require("url");
const { glookoConnect } = require('./glooko-login'); // Playwright browser login and data retrieval

var helper = require("./convert");
var { createNightscoutHelper } = require("./context");

/*
* Validate input:
*
* Takes input = env.extendedSettings.connect (the object with glookoEmail, glookoPassword, glookoEnv, glookoServer, glookoTimezoneOffset, etc.).
* Computes baseURL via base_for(input) from glookoServer / glookoEnv.
* Converts glookoTimezoneOffset (hours) to an offset in ms.
* Builds config with: glookoEnv, glookoServer, glookoEmail, glookoPassword, glookoTimezoneOffset (ms), baseURL, and kind.
* Returns { ok, errors, config }. That config is the opts object used everywhere else in the Glooko source.
*/

_known_servers = {
  default: "api.glooko.com",
  development: "api.glooko.work",
  production: "externalapi.glooko.com",
  eu: "eu.api.glooko.com",
};

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

function glookoSource(opts) {

  // Create a shared Nightscout helper for pre-fetching existing records.
  // URL and token come from environment variables with sensible defaults.
  var ns = createNightscoutHelper({
    url: process.env.NIGHTSCOUT_URL,
    token: process.env.NIGHTSCOUT_TOKEN,
  });

  var impl = {
    async authFromCredentials() {
      // left empty because glookoConnect below includes auth
      },

    async sessionFromAuth(auth) {
      // left empty because glookoConnect below manages the session
    },
  
    async dataFromSesssion() {
      // run Playwright login each time data is polled to enable Omnipod 5 to re-sync
      const results = await glookoConnect(opts);
      if (!results || results.success === false) {
        // Timeout or other login error — skip transformData but let the builder loop retry
        const msg = (results && results.error) || 'glookoConnect returned no data';
        console.log('GLOOKO skipping transform due to error:', msg);
        throw new Error(msg);
      }
      return results;
    },

    align_to_glucose() {
      // TODO
    },

    async transformData(batch) {
      // endpoint results `glookoConnect`.
      console.log("GLOOKO passing batch for transforming");

      // Determine what Nightscout context the converter needs
      var inputBatch = helper.assign_objects(batch);
      var hasReservoirChanges = inputBatch.reservoirChange && inputBatch.reservoirChange.length > 0;
      var hasPumpAlarms = inputBatch.pumpAlarms && inputBatch.pumpAlarms.length > 0;

      // Pre-fetch existing records from Nightscout
      var nsContext = await ns.buildContext({
        hasReservoirChanges,
        hasPumpAlarms,
        hasCgmChanges: inputBatch.cgmSensorChange && inputBatch.cgmSensorChange.length > 0,
        hasDailyTotals: inputBatch.dailyInsulinTotals && inputBatch.dailyInsulinTotals.length > 0
      });

      const { treatments, devicestatus } = await helper.generate_nightscout_treatments(
        batch,
        opts.glookoTimezoneOffset,
        nsContext
      );
      return { entries: [], treatments, devicestatus };
    },
  };
  
  function tracker_for() {
    return { getGeneratedHar: () => [], reset: () => {} };
  }

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
          // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000,
        },
        // only try 3 times to get data
        maxRetries: 1,
      },
      // expect new data 10 minutes after last success
      // avoid overload as new login is called each time
      expected_data_interval_ms: 10 * 60 * 1000,
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