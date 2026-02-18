#!/usr/bin/env node

/*
* 
* https://github.com/nightscout/nightscout-connect/issues/14#issuecomment-3239520325
* Lorenzo Sandini
* Uses Puppeteer to simulate real browser authentication
* 
*/

const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');

console.log('🎯 COMPLETE GLOOKO INTEGRATION');
console.log('==============================');
console.log('This script demonstrates:');
console.log('1. ✅ Login to Glooko using Puppeteer');
console.log('2. ✅ Automatic patient ID extraction from DOM');
console.log('3. ✅ API authentication with extracted cookies');
console.log('4. ✅ Data retrieval using the patient ID');
console.log('');

// configuration
const { loadGlookoConfig } = require('./lib/sources/glooko/loadConfig.js');
const { spec, opts } = loadGlookoConfig();

// Then call validate:
// const glookoSource = require('./index');
// const result = glookoSource.validate(opts);

// if (result.ok) {
//   console.log('Glooko config valid:', result.config);
//   // Use result.config for driver generation
// } else {
//   console.error('Validation errors:', result.errors);
// }

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

function constructApiUrl(endpoint, patientId, series) {
  const now = new Date();
  const days = 3;
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

async function glookoConnect() {
  let browser;
  
  try {
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
    
    console.log('\n🌐 STEP 4: API DATA RETRIEVAL');
    console.log('=============================');
    
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
    //   { name: 'Foods', url: '/api/v2/foods', requiresPatient: false },
    //   { name: 'Insulins', url: '/api/v2/insulins', requiresPatient: false },
    //   { name: 'Pump Settings', url: '/api/v2/pumps/settings', requiresPatient: false },
    //   { name: 'Pump Bolus', url: '/api/v2/pumps/normal_boluses', requiresPatient: false },
    //   { name: 'Pump Basal', url: '/api/v2/pumps/scheduled_basals', requiresPatient: false },
    //   { name: 'CGM Readings', url: '/api/v2/cgm/readings', requiresPatient: false },
    //   { name: 'Reservoir Change', url: '/api/v3/graph/data', requiresPatient: true, series: 'reservoirChange' },
      { name: 'Insulin Per Day', url: '/api/v3/graph/data', 
        requiresPatient: true, series: 'totalInsulinPerDay',
        startDate: '2026-02-17T00:00:00.000Z', 
        endDate: '2026-02-18T23:59:59.999Z' },
      { name: 'Last Sync', url: '/api/v3/devices_and_settings', 
        requiresPatient: true, series: 'to',
        startDate: '2026-02-17T00:00:00.000Z', 
        endDate: '2026-02-19T11:59:59.999Z' },      { name: 'Insulin2 Per Day', url: '/api/v3/graph/data', 
        requiresPatient: true, series: 'totalInsulinPerDay',
        startDate: '2026-02-16T12:00:00.000Z', 
        endDate: '2026-02-19T11:59:59.999Z' },
      { name: 'Insulin Per Day3', url: '/api/v3/graph/data', 
        requiresPatient: true, series: 'totalInsulinPerDay',
        startDate: '2026-02-17T05:00:00.000Z', 
        endDate: '2026-02-18T23:59:59.999Z' },
      { name: 'Insulin Per Day4', url: '/api/v3/graph/data', 
        requiresPatient: true, series: 'totalInsulinPerDay',
        startDate: '2026-02-17T05:00:00.000Z', 
        endDate: '2026-02-19T11:59:59.999Z' },
      { name: 'Insulin Per Day5', url: '/api/v3/graph/data', 
        requiresPatient: true, series: 'totalInsulinPerDay',
        startDate: '2026-02-17T12:00:00.000Z', 
        endDate: '2026-02-18T11:59:59.999Z' }
    ];
    
    const results = {};
    const output = {};
    
    for (const endpoint of endpoints) {
      try {
        console.log(`📋 Testing ${endpoint.name}...`);

        const url = 
        endpoint.url + 
        "?patient=" + patientId +
        "&startDate=" + endpoint.startDate +
        "&endDate=" + endpoint.endDate +
        "&series[]=" + endpoint.series;
        // `/api/v3/graph/data?patient=eu-west-1-purple-farwell-8737&startDate=${startDate}&endDate=${endDate}&series[]=totalInsulinPerDay`

        console.log(url);
        
        const response = await apiHttp.get(url);
        
        // console.log(`✅ ${endpoint.name}: ${response.data}`);

        function objects_from_daily_totals(results,startDate,endDate) {
          console.log("RESULTS  ",results);
          var data = results.series || {};
          var dayTotals = results.series.dailyInsulinTotals;

          // console.log("DATA  ",data);
          // console.log("TOTALS  ",dayTotals);
          

          if (!dayTotals || typeof dayTotals !== 'object' || Array.isArray(dayTotals)) {
            return undefined;
          }

          return Object.keys(dayTotals)
            .sort()
            .map(function (epochSeconds) {
              return Object.assign({
                currentTime: new Date().toISOString(),
                startDate: startDate,
                endDate: endDate,
                timestamp: new Date(Number(epochSeconds) * 1000).toISOString(),
                epochSeconds: Number(epochSeconds),
                totalInsulinPerDay: dayTotals.totalInsulinPerDay
              }, dayTotals[epochSeconds]);
            });
        }
        
        if (response.data) {
          const dataType = Array.isArray(response.data) ? 'array' : typeof response.data;
          const dataSize = Array.isArray(response.data) ? response.data.length : 
                          typeof response.data === 'object' ? Object.keys(response.data).length : 1;

          output[endpoint.name] = objects_from_daily_totals(response.data, endpoint.startDate, endpoint.endDate) || [];
          console.log(output[endpoint.name]);
          
          // console.log(`   📊 Data type: ${dataType}, size: ${dataSize} items`);
          
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
    
    // console.log('\n🔄 STEP 5: DATA PROCESSING DEMO');
    // console.log('===============================');
    
    let processedReadings = 0;
    let processedTreatments = 0;
    
    // Simulate Nightscout data processing
    for (const [endpointName, result] of Object.entries(results)) {
      if (result.success && Array.isArray(result.data)) {
        if (endpointName === 'CGM Readings') {
          console.log(`📋 Processing ${result.dataSize} CGM readings...`);
          
          const mockEntries = result.data.slice(0, 3).map((reading, index) => ({
            date: new Date().getTime() - (index * 5 * 60 * 1000),
            dateString: new Date(Date.now() - (index * 5 * 60 * 1000)).toISOString(),
            sgv: reading.value || 120 + (Math.random() - 0.5) * 40,
            type: 'sgv',
            direction: 'Flat',
            device: 'glooko-cgm'
          }));
          
          processedReadings = mockEntries.length;
          console.log(`✅ Converted to ${processedReadings} Nightscout entries`);
          
        } else if (endpointName.includes('Pump')) {
          console.log(`📋 Processing ${result.dataSize} pump records...`);
          processedTreatments += result.dataSize;
          console.log(`✅ Converted to ${result.dataSize} treatments`);
        }
      }
    }
    
    // console.log('\n📊 INTEGRATION SUMMARY');
    // console.log('======================');
    
    const successfulEndpoints = Object.values(results).filter(r => r.success).length;
    const totalEndpoints = Object.keys(results).length;
    
    // console.log(`🔐 Authentication: ✅ SUCCESS`);
    // console.log(`👤 Patient ID: ✅ ${patientId} (auto-extracted)`);
    // console.log(`🌐 API Endpoints: ${successfulEndpoints}/${totalEndpoints} successful`);
    // console.log(`📈 Glucose Readings: ${processedReadings} processed`);
    // console.log(`💉 Treatments: ${processedTreatments} processed`);
    
    // console.log('\n🎯 FINAL STATUS');
    // console.log('===============');
    
    if (successfulEndpoints >= 2) {
      // console.log('🎉 SUCCESS: Complete Glooko integration working!');
      // console.log('   ✅ Automatic login with Puppeteer');
      // console.log('   ✅ Patient ID extraction from DOM');
      // console.log('   ✅ Session cookie transfer to API calls');
      // console.log('   ✅ Data retrieval and processing');
      // console.log('');
      // console.log('🚀 Ready for Nightscout Connect integration!');
    } else {
      // console.log('❌ PARTIAL: Some endpoints failed');
      // console.log('   Authentication and patient ID extraction work,');
      // console.log('   but data endpoints need further investigation.');
    }
    
    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      patientId,
      output,
      summary: {
        authenticationSuccess: true,
        patientIdExtracted: true,
        successfulEndpoints,
        totalEndpoints,
        processedReadings,
        processedTreatments
      }
    };
    
    fs.writeFileSync('glooko-summary.json', JSON.stringify(summary, null, 2));
    console.log('\n📄 Detailed summary saved to glooko-summary.json');
    
    return {
      success: true,
      patientId,
      authenticationWorking: true,
      patientIdWorking: true,
      apiWorking: successfulEndpoints >= 2,
      readyForNightscout: successfulEndpoints >= 2
    };
    
  } catch (error) {
    // console.error('\n❌ INTEGRATION FAILED');
    // console.error('====================');
    // console.error('Error:', error.message);
    
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

// Run the complete integration
glookoConnect().then(result => {
  // console.log('\n🏁 SCRIPT COMPLETE');
  // console.log('==================');
  
  if (result.success && result.readyForNightscout) {
    // console.log('🎉 SUCCESS: Full integration verified!');
    // console.log('   Patient ID:', result.patientId);
    process.exit(0);
  } else {
    // console.log('❌ FAILED: Integration incomplete');
    process.exit(1);
  }
}).catch(error => {
  console.error('❌ SCRIPT ERROR:', error.message);
  process.exit(1);
});