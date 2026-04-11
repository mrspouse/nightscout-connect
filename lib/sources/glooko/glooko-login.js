/*
* 
* https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
* Lorenzo Sandini
* Uses Playwright browser authentication to trigger Omnipod 5 sync
* 
*/

const { chromium } = require('playwright');
const axios = require('axios');
const { execSync } = require('child_process');
const moment = require('moment');
const days = 5;  // number of days to fetch data for

function checkEnvironmentDependencies() {
  console.log('--- Environment Dependency Check ---');
  if (process.platform !== 'linux') {
    console.log('   Skipped (not required on this OS)');
    console.log('-----------------------------------');
    return;
  }
  
  const libs = [
    'libnspr4.so', 'libnss3.so', 'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0',
    'libcups.so.2', 'libdrm.so.2', 'libxkbcommon.so.0', 'libXcomposite.so.1',
    'libXdamage.so.1', 'libXrandr.so.2', 'libgbm.so.1', 'libasound.so.2'
  ];
  
  try {
    const output = execSync('ldconfig -p', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const missing = libs.filter(lib => !output.includes(lib));
    
    if (missing.length > 0) {
      console.log('⚠️  Potential missing system libraries:');
      missing.forEach(lib => console.log(`   - ${lib}`));
      console.log('   Run "sudo npx playwright install-deps" to fix.');
    } else {
      console.log('✅ All common system libraries are present.');
    }
  } catch (e) {
    console.log('   Skipped (ldconfig failed or is not available)');
  }
  console.log('-----------------------------------');
}

function getApiParams(endpoint, patientId) {
  const startDate = moment.utc().subtract(days, 'days').startOf('day');
  
  // V2 endpoints need lastUpdatedAt, lastGuid, and limit
  if (endpoint.url.includes('/api/v2/')) {
    return {
      lastUpdatedAt: startDate.toISOString(),
      lastGuid: '1e0c094e-1e54-4a4f-8e6a-f94484b53789',
      limit: 100
    };
  }
  
  const endDate = moment.utc().endOf('day');
  
  // V3 endpoints
  const params = {
    patient: patientId,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  };
  
  if (endpoint.series) {
    params['series[]'] = endpoint.series;
  }
  
  return params;
}

async function glookoConnect(opts) {
  let browser;
  
  try {
    const config = {
      email: opts.glookoEmail,
      password: opts.glookoPassword,
      env: opts.glookoEnv,
      webUrl: 'https://eu.my.glooko.com',
      apiUrl: 'https://eu.api.glooko.com',
      timezoneOffset: opts.glookoTimezoneOffset
    };

    console.log('Configuration:');
    console.log(`   Email: ${config.email}`);
    console.log(`   Environment: ${config.env}`);
    console.log(`   Web URL: ${config.webUrl}`);
    console.log(`   API URL: ${config.apiUrl}`);
    console.log('');

    checkEnvironmentDependencies();
    
    console.log('Launching Playwright browser');
    const headless = process.env.CONNECT_GLOOKO_HEADLESS !== 'false';
    const slowMo = parseInt(process.env.CONNECT_GLOOKO_SLOW_MO || '0', 10);
    
    console.log(`   Headless mode: ${headless}`);
    
    try {
      browser = await chromium.launch({ 
        headless,
        slowMo,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Add sandbox flags for better compatibility
      });
    } catch (launchError) {
      console.error('\n❌ CRITICAL: Failed to launch Playwright browser!');
      console.error('Error Message:', launchError.message);
      if (launchError.message.includes('executable doesn\'t exist')) {
        console.error('👉 Tip: Try running "npx playwright install chromium"');
      }
      throw launchError;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    console.log('Navigating to login page');
    await page.goto(config.webUrl + '/users/sign_in?locale=en-GB&redirect_to=/api/v3/session/users', { waitUntil: 'networkidle' });
    
    console.log('Logging in...');
    await page.fill('input[type="email"], input[name="email"], #email, input[name="user[email]"]', config.email);
    
    try {
      await page.waitForSelector('input[type="password"], input[name="password"], #password, input[name="user[password]"]', { state: 'visible', timeout: 5000 });
      await page.fill('input[type="password"], input[name="password"], #password, input[name="user[password]"]', config.password);
    } catch(e) {
      console.log('Password field not immediately visible. May require "Next" click.');
      const nextBtn = await page.$('button[type="submit"], button:has-text("Next"), button:has-text("Continue"), input[type="submit"]');
      if (nextBtn) await nextBtn.click();
      
      await page.waitForSelector('input[type="password"], input[name="password"], #password, input[name="user[password]"]', { state: 'visible' });
      await page.fill('input[type="password"], input[name="password"], #password, input[name="user[password]"]', config.password);
    }
    
    const submitBtn = await page.$('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), input[type="submit"]');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');
    
    console.log('Waiting for authentication...');
    await page.waitForURL('**/api/v3/session/users', { timeout: 15000 }); // Wait specifically for redirection
    
    console.log('✅ Login successful!');
    
    console.log('Extracting session cookies...');
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    console.log(`\n✅ Extracted ${cookies.length} session cookies`);

    // Check if we reached the API response page
    const currentUrl = page.url();
    if (!currentUrl.includes('/api/v3/session/users')) {
      throw new Error(`Did not redirect to expected URL. Current URL: ${currentUrl}`);
    }

    const pageText = await page.evaluate(() => document.body.innerText);
    let glookoCode = null;
    let lastSyncTimestamps = null;

    try {
      const body = JSON.parse(pageText);
      const user = body.currentUser || body.currentPatient || body;
      
      if (user && user.glookoCode) {
        glookoCode = user.glookoCode;
        lastSyncTimestamps = user.lastSyncTimestamps || {};
      } else {
        throw new Error('glookoCode not found in JSON response');
      }
    } catch(e) {
      throw new Error('Failed to parse JSON from redirected page: ' + e.message);
    }
    const patientId = glookoCode;
    // get pump timestamp from overall timestamps object
    const { pump } = lastSyncTimestamps;
    const lastPumpSyncTimestamp = new Date(pump);

    console.log(`\n✅ Patient ID: ${patientId}`);
    console.log('\nLast Sync Timestamps:', lastSyncTimestamps);
    console.log('Last Pump Sync:', lastPumpSyncTimestamp.toISOString());
        
    if (!patientId) {
      throw new Error('Could not extract patient ID');
    }
    
    console.log('\nAPI DATA');

    const apiHttp = axios.create({ 
      baseURL: config.apiUrl, 
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        'Referer': config.webUrl + '/logbook',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    });
    
    // Extract normal boluses from histories, reservoir change and insulin per day from V3 API
    // No CGM entries as these are uploaded separately
    const endpoints = [
      { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
      { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
      { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
      { name: 'Histories', url: '/api/v3/users/summary/histories', requiresPatient: true },  // no series: normal boluses and alarms
      { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
      { name: 'cgmSensorChange', url: '/api/v3/graph/data', requiresPatient: true, series: 'cgmSensorChange' },
      { name: 'Insulin Per Day', url: '/api/v3/graph/data', requiresPatient: true, series: 'totalInsulinPerDay' },
    ];
    
    const results = {};
    
    await Promise.all(endpoints.map(async (endpoint) => {
      try {
        console.log(`📋 Fetching ${endpoint.name}...`);
        
        const params = getApiParams(endpoint, patientId);
        
        console.log(`   -> Endpoint: ${endpoint.url}`);
        
        const response = await apiHttp.get(endpoint.url, { params });
        
        console.log(`✅ ${endpoint.name}: ${response.status} - Success!`);
        
        if (response.data) {
          const dataType = Array.isArray(response.data) ? 'array' : typeof response.data;
          const dataSize = Array.isArray(response.data) ? response.data.length : 
                          typeof response.data === 'object' ? Object.keys(response.data).length : 1;
          
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
    }));
    
    // collate batch output for processing
    const batch = {
      patientId,
      timestamp: new Date().toISOString(),
      lastPumpSyncTimestamp,
      glookoTimezoneOffset: config.timezoneOffset,
      results
    };
    return batch;
    
  } catch (error) {
    console.error('\n❌ API FAILED');
    console.error('=============');
    console.error('Error:', error.message);
    
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (browser) {
      console.log('Cleaning up: closing browser...');
      await browser.close();
      console.log('Cleanup: browser closed.');
    }
  }
}

module.exports = { glookoConnect };