require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const username = process.env.GLOOKO_USERNAME;
  const password = process.env.GLOOKO_PASSWORD;

  if (!username || !password) {
    console.error('GLOOKO_USERNAME and GLOOKO_PASSWORD environment variables are required.');
    process.exit(1);
  }

  // Launch browser (headed for debugging, change headless to true for automated runs)
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  let glookoCode = null;
  let lastSyncTimestamps = null;

  try {
    const loginUrl = 'https://eu.my.glooko.com/users/sign_in?locale=en-GB&redirect_to=/api/v3/session/users';
    console.log(`Navigating to Glooko EU login: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle' });

    // Fill in credentials and submit
    console.log('Logging in...');
    await page.fill('input[type="email"], input[name="email"], #email', username); // Adjust selectors if needed
    // Sometimes there is a next button, or standard login form. Let's try standard selectors.
    // If Glooko uses a modern auth flow, we might need a two-step. 
    // Wait for password field to be visible or next button.
    
    // Playwright locator wait:
    try {
      await page.waitForSelector('input[type="password"], input[name="password"], #password', { state: 'visible', timeout: 5000 });
      await page.fill('input[type="password"], input[name="password"], #password', password);
    } catch(e) {
      console.log('Password field not immediately visible. May require "Next" click.');
      // Click next or submit if it's a two-step form
      const nextBtn = await page.$('button[type="submit"], button:has-text("Next"), button:has-text("Continue")');
      if (nextBtn) await nextBtn.click();
      
      await page.waitForSelector('input[type="password"], input[name="password"], #password', { state: 'visible' });
      await page.fill('input[type="password"], input[name="password"], #password', password);
    }
    
    // Submit login
    console.log('Taking screenshot before submit...');
    await page.screenshot({ path: 'before-submit.png', fullPage: true });
    
    const submitBtn = await page.$('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');

    // Wait until logged in and redirected to /api/v3/session/users
    console.log('Waiting for authentication and redirect to session data...');
    
    await page.waitForTimeout(5000); // Wait a bit for navigation
    
    // Check if we reached the API response page
    const currentUrl = page.url();
    if (currentUrl.includes('/api/v3/session/users')) {
      const pageText = await page.evaluate(() => document.body.innerText);
      try {
        const body = JSON.parse(pageText);
        // The previous HTML dump showed the structure is: { currentUser: { glookoCode: '...', lastSyncTimestamps: { ... } } }
        // or directly depending on the API. Let's handle both.
        const user = body.currentUser || body.currentPatient || body;
        
        if (user && user.glookoCode) {
          glookoCode = user.glookoCode;
          lastSyncTimestamps = user.lastSyncTimestamps || {};
          console.log('\n--- Extracted from /api/v3/session/users ---');
          console.log('glookoCode:', glookoCode);
          console.log('lastSyncTimestamps:', lastSyncTimestamps);
        } else {
            throw new Error('glookoCode not found in JSON response');
        }
      } catch(e) {
        throw new Error('Failed to parse JSON from redirected page: ' + e.message);
      }
    } else {
       console.log('Taking screenshot of timeout state...');
       await page.screenshot({ path: 'login-timeout.png', fullPage: true });
       const html = await page.content();
       require('fs').writeFileSync('timeout-page.html', html);
       throw new Error(`Did not redirect to expected URL. Current URL: ${currentUrl}`);
    }

    console.log('\nSuccessfully logged in and retrieved session data.');

    // Now make the authorized request to /api/v3/graph/data
    console.log('\nFetching /api/v3/graph/data ...');
    
    // Using page.evaluate so we make the request directly from the browser window using fetch
    const graphDataResult = await page.evaluate(async (gCode) => {
      // Use the provided patient ID, startDate, and endDate as requested by the user API spec:
      // Note: we dynamically use the extracted gCode for the patient parameter.
      const apiUrl = `/api/v3/graph/data?patient=${gCode}&startDate=2026-03-02T00:00:00.000Z&endDate=2026-03-06T23:59:59.999Z&series[]=totalInsulinPerDay`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        return { error: true, status: response.status, text: await response.text() };
      }
      return await response.json();
    }, glookoCode);
    
    if (graphDataResult.error) {
      console.error('Failed to fetch graph data:', graphDataResult.status, graphDataResult.text);
    } else {
      console.log('--- Graph Data (/api/v3/graph/data) ---');
      console.log(JSON.stringify(graphDataResult, null, 2).substring(0, 1000) + '...\n(truncated for brevity)');
    }

  } catch (err) {
    console.error('Error during scraping:', err);
  } finally {
    console.log('\nClosing browser...');
    await browser.close();
  }
})();
