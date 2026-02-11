User: how does auth work

GitHub Copilot: Optimizing tool selection...

Read [](file:///Users/glyn/Git/nightscout-connect/lib/sources/glooko/index.js#1-1), lines 1 to 100

Read [](file:///Users/glyn/Git/nightscout-connect/lib/sources/glooko/index.js#100-100), lines 100 to 200

The Glooko authentication works like this:

1. **Login Request** - `authFromCredentials()` sends a POST to `/api/v2/users/sign_in` with:
   - Email and password in the payload
   - Device information (OS, version, device model, app version, etc.) to mimic a mobile app

2. **Cookie Extraction** - The response includes a `Set-Cookie` header which is extracted and stored:
   ```javascript
   const result = { cookies: response.headers['set-cookie'][0], user: response.data };
   ```

3. **Session Reuse** - The `sessionFromAuth()` method passes the auth object through unchanged

4. **Authenticated Requests** - When fetching data in `dataFromSession()`, the stored cookie is added to request headers:
   ```javascript
   headers["Cookie"] = session.cookies;
   ```

5. **Data Fetching** - Uses the authenticated session to fetch multiple endpoints (foods, insulins, pump basals, CGM readings, etc.) with the user's session cookie

The key is that Glooko uses **cookie-based authentication** - once you log in with credentials, you get a session cookie back that's then included in all subsequent requests to maintain the authenticated session.

User: build me an authenticated endpoint request to fetch insulins

GitHub Copilot: Here's an authenticated request to fetch insulins based on the patterns in the code:

```javascript
/**
 * Fetch insulins with authentication
 * @param {object} session - Session with cookies and user data from authFromCredentials()
 * @param {object} http - Authenticated axios instance
 * @param {object} opts - Configuration including glookoServer and glookoEmail
 * @returns {Promise<any>}
 */
async function fetchInsulins(session, http, opts) {
  const startDate = new Date(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).setHours(0, 0, 0, 0)).toISOString();
  const endDate = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();
  
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    Cookie: session.cookies,
    Host: opts.glookoServer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site"
  };

  const params = {
    lastGuid: "1e0c094e-1e54-4a4f-8e6a-f94484b53789",
    lastUpdatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    limit: 100
  };

  return http.get("/api/v2/insulins", { headers, params }).then(resp => resp.data);
}
```

The key parts:
- **Cookie header** - Contains the session cookie from login
- **Date range** - Last 2 days by default
- **Host header** - Set to the Glooko server (eu.api.glooko.com or similar)
- **Sec-Fetch headers** - Indicate this is a CORS request from the browser

This assumes you've already called `authFromCredentials()` to get the session with the cookies.

User: use python to build me an authenticated endpoint request to fetch insulins

GitHub Copilot: 

```python
import requests
from datetime import datetime, timedelta
import json

class GlookoClient:
    def __init__(self, email, password, server="api.glooko.com"):
        self.email = email
        self.password = password
        self.server = server
        self.base_url = f"https://{server}"
        self.session = requests.Session()
        self.cookies = None
        
    def authenticate(self):
        """Login and get session cookie"""
        endpoint = f"{self.base_url}/api/v2/users/sign_in"
        
        payload = {
            "userLogin": {
                "email": self.email,
                "password": self.password
            },
            "deviceInformation": {
                "applicationType": "logbook",
                "os": "android",
                "osVersion": "33",
                "device": "Google Pixel 8 Pro",
                "deviceManufacturer": "Google",
                "deviceModel": "Pixel 8 Pro",
                "serialNumber": "HIDDEN",
                "clinicalResearch": False,
                "deviceId": "HIDDEN",
                "applicationVersion": "6.1.3",
                "buildNumber": "0",
                "gitHash": "g4fbed2011b"
            }
        }
        
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate, br",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
            "Content-Type": "application/json",
            "Referer": "https://eu.my.glooko.com/",
            "Origin": "https://eu.my.glooko.com"
        }
        
        response = requests.post(endpoint, json=payload, headers=headers)
        response.raise_for_status()
        
        # Store cookies from response
        self.session.cookies.update(response.cookies)
        self.cookies = response.cookies
        
        print("✓ Authenticated successfully")
        return response.json()
    
    def fetch_insulins(self):
        """Fetch insulins with authentication"""
        endpoint = f"{self.base_url}/api/v2/insulins"
        
        # Calculate date range (last 2 days)
        now = datetime.utcnow()
        two_days_ago = now - timedelta(days=2)
        start_date = two_days_ago.replace(hour=0, minute=0, second=0, microsecond=0).isoformat() + "Z"
        end_date = now.replace(hour=23, minute=59, second=59, microsecond=999).isoformat() + "Z"
        
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate, br",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
            "Host": self.server,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-site"
        }
        
        params = {
            "lastGuid": "1e0c094e-1e54-4a4f-8e6a-f94484b53789",
            "lastUpdatedAt": two_days_ago.isoformat() + "Z",
            "limit": 100
        }
        
        response = self.session.get(endpoint, headers=headers, params=params)
        response.raise_for_status()
        
        print("✓ Insulins fetched successfully")
        return response.json()


# Usage
if __name__ == "__main__":
    client = GlookoClient(
        email="your_email@example.com",
        password="your_password",
        server="eu.api.glooko.com"  # or "api.glooko.com", "api.glooko.work", etc.
    )
    
    # Authenticate
    auth_result = client.authenticate()
    
    # Fetch insulins
    insulins = client.fetch_insulins()
    print(json.dumps(insulins, indent=2))
```

Key features:
- **Session persistence** - Uses `requests.Session()` to automatically manage cookies across requests
- **Authentication** - Sends login with email, password, and device info to get session cookie
- **Authenticated requests** - Session automatically includes cookie in subsequent requests
- **Date handling** - Calculates 2-day date range in ISO format
- **Error handling** - `raise_for_status()` catches HTTP errors
- **Configurable server** - Supports different Glooko endpoints (eu, prod, dev)