#!/usr/bin/env node

/*
* 
* https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
* Lorenzo Sandini
* Uses Puppeteer to simulate browser authentication and force sync update
* 
*/

const puppeteer = require('puppeteer');
const axios = require('axios');

function constructApiUrl(endpoint, patientId, series) {
  const now = new Date();
  const days = 3;  // increase to 3 days for daily pod totals
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
  const apiSeries = series ? "&series[]=" + series : "";
  return endpoint + 
    "?patient=" + patientId +
    "&startDate=" + new Date(daysAgo.setHours(0,0,0,0)).toISOString() +
    "&endDate=" + new Date(now.setHours(23,59,59,999)).toISOString()+
    apiSeries;
}

async function glookoConnect(opts) {
  let browser;
  
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

  try {
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
    await page.goto(config.webUrl + '/users/sign_in', {
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
    
    // Patient ID

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

    // API Data Retrieval

    const apiHttp = axios.create({ 
      baseURL: config.apiUrl, 
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        'Referer': config.webUrl + '/dashboard',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    });
    
    // Keep original endpoints and add reservoir change and insulin per day from V3 API
    const endpoints = [
      { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
      { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
      // { name: 'Pump Settings', url: '/api/v2/pumps/settings', requiresPatient: false },
      { name: 'Pump Bolus', url: '/api/v2/pumps/normal_boluses', requiresPatient: false },
      { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
      { name: 'CGM Readings', url: '/api/v2/cgm/readings', requiresPatient: false },
      { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
      { name: 'Insulin Per Day', url: '/api/v3/graph/data', requiresPatient: true, series: 'totalInsulinPerDay' },
      { name: 'Last Sync', url: '/api/v3/devices_and_settings', requiresPatient: true, series: false }
    ];
    
    const results = {};
    
    for (const endpoint of endpoints) {
      try {
        console.log(`📋 ${endpoint.name}...`);
        
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
          
          // console.log(`   📊 Data type: ${dataType}, size: ${dataSize} items`);
          
          if (Array.isArray(response.data) && response.data.length > 0) {
            // console.log(`   📊 Sample keys: ${Object.keys(response.data[0] || {}).slice(0, 5).join(', ')}`);
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
    
    // Return the aggregated endpoint results so they can be
    // consumed by the source driver and converter.
    return results;
    
  } catch (error) {
    console.error('\n❌ INTEGRATION FAILED');
    console.error('====================');
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