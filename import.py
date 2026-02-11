import requests
from datetime import datetime, timezone, timedelta
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
        
        # Calculate date range (last 2 days)
        now = datetime.now()
        days_ago = now - timedelta(days=2)
        start_date = days_ago.replace(hour=0, minute=0, second=0, microsecond=0).isoformat() + "Z"
        end_date = now.replace(hour=23, minute=59, second=59, microsecond=999).isoformat() + "Z"
        
        endpoint = f"{self.base_url}/api/v2/graph"
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
            # "patient": "eu-west-1-purple-farwell-8737",
            "lastUpdatedAt": start_date,
            # "end_date": end_date,
            "lastGuid": "1e0c094e-1e54-4a4f-8e6a-f94484b53789",
            "limit": 100
        }
        
        response = self.session.get(endpoint, headers=headers, params=params)

        # Print the prepared HTTP request for debugging
        req = response.request
        try:
            body = req.body.decode() if isinstance(req.body, bytes) else req.body
        except Exception:
            body = req.body
        print("--- Prepared HTTP Request ---")
        print("Method:", req.method)
        print("URL:", req.url)
        print("Headers:", dict(req.headers))
        print("Body:", body)
        print("Params:", params)
        print("-----------------------------")

        response.raise_for_status()

        print("✓ Insulins fetched successfully")
        return response.json()

# Usage
if __name__ == "__main__":
    client = GlookoClient(
        email="glynmail@gmail.com",
        password="Ashfield@47",
        server="eu.api.glooko.com"  # or "api.glooko.com", "api.glooko.work", etc.
    )
    
    # Authenticate
    auth_result = client.authenticate()
    
    # Fetch insulins
    insulins = client.fetch_insulins()
    print(json.dumps(insulins, indent=2))
