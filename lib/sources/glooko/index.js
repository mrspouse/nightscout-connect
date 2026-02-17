/*
 *
 * https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
 * Authors:
 * Jeremy Pollock
 * https://github.com/jpollock
 * Jon Fawcett
 * and others.
 */
var url = require("url");
const puppeteer = require('puppeteer');

var helper = require("./convert");

// configuration for local running
const { loadGlookoConfig } = require('./loadConfig.js');

/** @type {Object<string, string>} */
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
  mime: "application/json"
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

function constructApiUrl(endpoint, patientId, series) {
  const now = new Date();
  const days = 8;
  const daysAgo = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
  
  // V2 endpoints need lastUpdatedAt, lastGuid, and limit
  if (endpoint.includes('/api/v2/')) {
    return endpoint + 
      // "?patient=" + patientId +
      "?lastUpdatedAt=" + new Date(daysAgo.setHours(0,0,0,0)).toISOString() +
      "&lastGuid=1e0c094e-1e54-4a4f-8e6a-f94484b53789" +
      "&limit=100";
  }
  
  // V3 endpoints
  return endpoint + 
    "?patient=" + patientId +
    "&startDate=" + new Date(daysAgo.setHours(0,0,0,0)).toISOString() +
    "&endDate=" + new Date(now.setHours(23,59,59,999)).toISOString()+
    "&series[]=" + series;
}

 /**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.glookoServer]
 * @param {string} [opts.glookoEnv]
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @param {number} [opts.glookoTimezoneOffset]
 * @param {import('axios').AxiosStatic} axios
 * @returns {object}
 */
function glookoSource(opts, axios) {
  const config = {
    email: opts.glookoEmail,
    password: opts.glookoPassword,
    env: opts.glookoEnv,
    webUrl: 'https://eu.my.glooko.com',
    apiUrl: 'https://eu.api.glooko.com',
    timezoneOffset: opts.glookoTimezoneOffset
  };

  console.log('📋 Configuration:');
  console.log(`   Email: ${config.email}`);
  console.log(`   Environment: ${config.env}`);
  console.log(`   Web URL: ${config.webUrl}`);
  console.log(`   API URL: ${config.apiUrl}`);
  console.log('');
  var baseURL = opts.baseURL; // This is likely eu.api.glooko.com, will be overridden for login

  var impl = {
    async authFromCredentials() {
      let browser;
      
        console.log('🔐 STEP 1: BROWSER AUTHENTICATION');
        console.log('==================================');
        
        console.log('🚀 Launching headless browser...');
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
        
        console.log('📋 Navigating to login page...');
        await page.goto(config.webUrl + '/users/sign_in?locale=fi', {
          waitUntil: 'networkidle0',
          timeout: 30000
        });
        
        console.log('📋 Filling and submitting login form...');
        await page.type('input[name="user[email]"]', config.email);
        await page.type('input[name="user[password]"]', config.password);
        
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
          page.click('input[type="submit"]')
        ]);
        
        console.log('✅ Login successful!');
        
        console.log('\n👤 STEP 2: PATIENT ID EXTRACTION');
        console.log('=================================');
        
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
        
        console.log('\n🍪 STEP 3: COOKIE EXTRACTION');
        console.log('============================');
        
        const cookies = await page.cookies();
        const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        console.log(`✅ Extracted ${cookies.length} session cookies`);
        
        await browser.close();
        browser = null;
        
        return {
          cookies: cookieHeader,
          patientId: patientId,
          user: { userLogin: { glookoCode: patientId } }
        };
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
    async dataFromSession(session, last_known) {
      // Extract data from session
      const cookieHeader = session.cookies;
      const patientId = session.user?.userLogin?.glookoCode;
      
      if (!cookieHeader || !patientId) {
        console.log('⚠️  Missing session data - cannot fetch from Glooko');
        return { entries: [], treatments: [] };
      }
      
      var two_days_ago = new Date().getTime() - 2 * 24 * 60 * 60 * 1000;
      var last_mills = Math.max(
        two_days_ago,
        last_known && last_known.entries
          ? last_known.entries.getTime()
          : two_days_ago
      );
      var maxCount = Math.ceil(
        (new Date().getTime() - last_mills) / (1000 * 60 * 5)
      );
      var lastUpdatedAt = new Date(two_days_ago);
      var params = {
        lastGuid: Defaults.lastGuid,
        lastUpdatedAt,
        limit: maxCount,
      };

      const apiHttp = axios.create({ 
        baseURL: opts.baseURL || 'https://eu.api.glooko.com',
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          'Referer': 'https://eu.my.glooko.com/dashboard',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site'
        }
      });
      
      // Keep original endpoints and add reservoir change and insulin per day from V3 API
      const endpoints = [
        { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
        { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
        { name: 'Pump Settings', url: '/api/v2/pumps/settings', requiresPatient: false },
        { name: 'Pump Bolus', url: '/api/v2/pumps/normal_boluses', requiresPatient: false },
        { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
        { name: 'CGM Readings', url: '/api/v2/cgm/readings', requiresPatient: false },
        { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
        { name: 'Insulin Per Day', url: '/api/v3/graph/data', requiresPatient: true, series: 'totalInsulinPerDay' }
      ];
      
      const results = {};
      
      for (const endpoint of endpoints) {
        try {
          console.log(`📋 Testing ${endpoint.name}...`);
          
          const url = endpoint.requiresPatient 
            ? constructApiUrl(endpoint.url, patientId, endpoint.series)
            : constructApiUrl(endpoint.url);

          console.log(url);
          
          const response = await apiHttp.get(url);
          
          console.log(`✅ ${endpoint.name}: ${response.status} - Success!`);
          
          if (response.data) {
            const dataType = Array.isArray(response.data) ? 'array' : typeof response.data;
            const dataSize = Array.isArray(response.data) ? response.data.length : 
                            typeof response.data === 'object' ? Object.keys(response.data).length : 1;
            
            console.log(`   📊 Data type: ${dataType}, size: ${dataSize} items`);
            
            if (Array.isArray(response.data) && response.data.length > 0) {
              console.log(`   📊 Sample keys: ${Object.keys(response.data[0] || {}).slice(0, 5).join(', ')}`);
            }
            
            results[endpoint.name] = {
              success: true,
              status: response.status,
              dataType,
              dataSize,
              data: response.data
            };
          }
          
        } catch (error) {
          const status = error.response?.status || 'Network Error';
          const errorMsg = error.response?.data?.message || error.message;
          const errorData = error.response?.data;
          
          console.log(`❌ ${endpoint.name}: ${status} - ${errorMsg}`);
          
          // Show detailed error for 422 responses to understand what's missing
          if (status === 422 && errorData) {
            console.log(`   📋 Error details:`, JSON.stringify(errorData, null, 2));
          }
          
          results[endpoint.name] = {
            success: false,
            status,
            error: errorMsg,
            errorData: errorData
          };
        }
      }

      console.log('📋 API Results:', results);

      // Transform results into Nightscout entries and treatments
      return {
        entries: [],
        treatments: []
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
      //console.log("TODO TRANSFORM", batch);
      var treatments = helper.generate_nightscout_treatments(
        batch,
        opts.glookoTimezoneOffset
      );
      return { entries: [], treatments };
    },
  };
  function tracker_for() {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
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
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 1000 * 60 * 60 * 24 * 1 - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      },
    });

    builder.register_loop("Glooko", {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSession,
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
      desc: "The Glooko User Login Email is required. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.",
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

// Standalone script execution
if (require.main === module) {
  (async () => {
    try {
      const { spec, opts } = loadGlookoConfig();
      
      console.log('🚀 Starting Glooko source as standalone script...\n');
      
      // Create axios instance for the source
      const axios = require('axios');
      
      // Validate configuration
      const validation = glookoSource.validate(opts);
      if (!validation.ok) {
        console.error('❌ Configuration validation failed:');
        validation.errors.forEach(err => {
          console.error(`   - ${err.desc}`);
        });
        process.exit(1);
      }
      
      // Initialize the source
      const source = glookoSource(opts, axios);
      
      // Create a minimal builder for standalone execution
      const builder = {
        support_session(config) {
          console.log('✅ Session support configured');
          return this;
        },
        register_loop(name, config) {
          console.log(`✅ Loop '${name}' registered`);
          return this;
        }
      };
      
      // Generate driver using the builder pattern
      console.log('Generating driver...\n');
      source.generate_driver(builder);
      
      console.log('✅ Standalone script completed successfully!');
      
    } catch (error) {
      console.error('❌ Error running standalone script:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  })();
}
