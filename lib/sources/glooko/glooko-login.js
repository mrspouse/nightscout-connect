/*
 * 
 * https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
 * Lorenzo Sandini
 * Uses Puppeteer browser authentication to trigger Omnipod 5 sync
 * 
 * Glooko is rejecting axios requests with 421 Misdirected Request
 * 
 * Claude Opus solution:
 * Replace axios-based API calls with page.evaluate(fetch(...)) inside the Puppeteer browser before closing it. 
 * The browser is already authenticated — just make the API calls from within its context.
 * 
 * Key changes:
 * Remove axios import (no longer needed)
 * Remove cookie extraction for API calls (no longer needed)
 * Move session/user API call (currently line 115) into page.evaluate
 * Move all data endpoint API calls (currently lines 160-213) into page.evaluate
 * Close browser AFTER all API calls complete (move browser.close() to the end)
 * Keep constructApiUrl logic but run it server-side before passing URLs to page.evaluate
 * 
 */

const puppeteer = require('puppeteer');

function constructApiUrl(baseUrl, endpoint, patientId, series) {
  const now = new Date();
  const days = 4;
  const daysAgo = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
  
  // V2 endpoints need lastUpdatedAt, lastGuid, and limit
  if (endpoint.includes('/api/v2/')) {
    return baseUrl + endpoint + 
      "?lastUpdatedAt=" + new Date(daysAgo.setHours(0,0,0,0)).toISOString() +
      "&lastGuid=1e0c094e-1e54-4a4f-8e6a-f94484b53789" +
      "&limit=100";
  }
  
  // V3 endpoints
  const apiSeries = series ? "&series[]=" + series : "";
  return baseUrl + endpoint + 
    "?patient=" + patientId +
    "&startDate=" + new Date(daysAgo.setHours(0,0,0,0)).toISOString() +
    "&endDate=" + new Date(now.setHours(23,59,59,999)).toISOString()+
    apiSeries;
}

async function glookoConnect(opts) {
  let browser;
  
  try {
    const config = {
      email: opts.glookoEmail,
      password: opts.glookoPassword,
      env: opts.glookoEnv,
      baseUrl: 'https://eu.my.glooko.com',
      timezoneOffset: opts.glookoTimezoneOffset
    };

    console.log('Configuration:');
    console.log(`   Email: ${config.email}`);
    console.log(`   Environment: ${config.env}`);
    console.log(`   URL: ${config.baseUrl}`);
    console.log('');

    console.log('Launching Puppeteer browser');
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
    
    console.log('Navigating to login page');
    await page.goto(config.baseUrl + '/users/sign_in', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    console.log('Submitting login');
    await page.type('input[name="user[email]"]', config.email);
    await page.type('input[name="user[password]"]', config.password);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 50000 }),
      page.click('input[type="submit"]')
    ]);
    
    console.log('✅ Login successful!');

    // Get Patient ID and sync timestamps from session API (via browser fetch)
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('\nFetching session user info via browser...');
    const sessionData = await page.evaluate(async (baseUrl) => {
      try {
        const res = await fetch(baseUrl + '/api/v3/session/users', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`Session API returned ${res.status}`);
        return { success: true, data: await res.json() };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, config.baseUrl);

    if (!sessionData.success) {
      throw new Error('Session API failed: ' + sessionData.error);
    }

    const { currentUser } = sessionData.data;
    const { glookoCode, lastSyncTimestamps } = currentUser;
    const patientId = glookoCode;
    const { pump } = lastSyncTimestamps;
    const lastPumpSyncTimestamp = new Date(pump);

    console.log(`\n✅ Patient ID: ${patientId}`);
    console.log('\nLast Sync Timestamps:', lastSyncTimestamps);
    console.log('Last Pump Sync:', lastPumpSyncTimestamp.toISOString());
        
    if (!patientId) {
      throw new Error('Could not extract patient ID');
    }

    // Fetch all data endpoints via browser fetch (before closing browser)
    console.log('\nAPI DATA');
    
    const endpoints = [
      { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
      { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
      { name: 'Pump Bolus', url: '/api/v2/pumps/normal_boluses', requiresPatient: false },
      { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
      { name: 'CGM Readings', url: '/api/v2/cgm/readings', requiresPatient: false },
      { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
      { name: 'Insulin Per Day', url: '/api/v3/graph/data', requiresPatient: true, series: 'totalInsulinPerDay' },
    ];
    
    const results = {};
    
    for (const endpoint of endpoints) {
      try {
        console.log(`📋 Fetching ${endpoint.name}...`);
        
        const fullUrl = endpoint.requiresPatient 
          ? constructApiUrl(config.baseUrl, endpoint.url, patientId, endpoint.series)
          : constructApiUrl(config.baseUrl, endpoint.url);

        console.log(fullUrl);
        
        // Make the API call from within the browser context
        const fetchResult = await page.evaluate(async (url) => {
          try {
            const res = await fetch(url, {
              credentials: 'include',
              headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) {
              const errorBody = await res.text().catch(() => '');
              return { success: false, status: res.status, error: `HTTP ${res.status}`, errorData: errorBody };
            }
            const data = await res.json();
            return { success: true, status: res.status, data };
          } catch (err) {
            return { success: false, status: 'Network Error', error: err.message };
          }
        }, fullUrl);
        
        if (fetchResult.success) {
          console.log(`✅ ${endpoint.name}: ${fetchResult.status} - Success!`);
          
          const data = fetchResult.data;
          const dataType = Array.isArray(data) ? 'array' : typeof data;
          const dataSize = Array.isArray(data) ? data.length : 
                          typeof data === 'object' ? Object.keys(data).length : 1;
          
          results[endpoint.name] = {
            success: true,
            status: fetchResult.status,
            dataType,
            dataSize,
            data
          };
        } else {
          console.log(`❌ ${endpoint.name}: ${fetchResult.status} - ${fetchResult.error}`);
          
          if (fetchResult.status === 422 && fetchResult.errorData) {
            console.log(`   📋 Error details:`, fetchResult.errorData);
          }
          
          results[endpoint.name] = {
            success: false,
            status: fetchResult.status,
            error: fetchResult.error,
            errorData: fetchResult.errorData
          };
        }
        
      } catch (error) {
        console.log(`❌ ${endpoint.name}: Error - ${error.message}`);
        
        results[endpoint.name] = {
          success: false,
          status: 'Error',
          error: error.message
        };
      }
    }
    
    // Close browser now that all API calls are done
    await browser.close();
    browser = null;

    // collate batch output for processing
    const batch = {
      patientId,
      timestamp: new Date().toISOString(),
      lastPumpSyncTimestamp,
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
      await browser.close();
    }
  }
}

module.exports = { glookoConnect };