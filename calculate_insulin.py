import urllib.request
import json
from datetime import datetime

def calculate_insulin():
    url = "https://ns-drop-gd.fly.dev/api/v1/devicestatus.json?find[device]=Insulet+Omnipod%C2%AE+5+System"
    
    print(f"Fetching data from {url}...")
    try:
        with urllib.request.urlopen(url) as response:
            if response.status != 200:
                print(f"Error fetching data: HTTP {response.status}")
                return
            data = json.loads(response.read().decode())
    except Exception as e:
        print(f"Error fetching data: {e}")
        return

    if not data:
        print("No data found.")
        return

    # Find the latest lastSiteChange and lastSync
    latest_site_change = None
    latest_sync = None
    for record in data:
        site_change_str = record.get('lastSiteChange')
        sync_str = record.get('lastSync')
        
        if site_change_str:
            dt = datetime.fromisoformat(site_change_str.replace('Z', '+00:00'))
            if latest_site_change is None or dt > latest_site_change:
                latest_site_change = dt
        
        if sync_str:
            dt = datetime.fromisoformat(sync_str.replace('Z', '+00:00'))
            if latest_sync is None or dt > latest_sync:
                latest_sync = dt

    if latest_site_change is None:
        print("No lastSiteChange found in records.")
        return

    site_change_date = latest_site_change.date()
    print(f"Latest site change: {latest_site_change}")
    print(f"Latest sync: {latest_sync}")
    print(f"Filtering entries on or after date: {site_change_date}")

    # Group the latest insulin entry for each day
    # dict: { date_object: (timestamp_string, insulin_total) }
    daily_latest_entries = {}

    for record in data:
        insulin_data = record.get('InsulinPerDay', [])
        for entry in insulin_data:
            ts_str = entry.get('timestamp')
            total = entry.get('totalPumpInsulinPerDay')
            
            if ts_str and total is not None:
                ts_dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                ts_date = ts_dt.date()
                
                if ts_date >= site_change_date:
                    # If we don't have this day yet, or this entry is later than the one we have
                    current_stored = daily_latest_entries.get(ts_date)
                    if current_stored is None or ts_str > current_stored[0]:
                        daily_latest_entries[ts_date] = (ts_str, total)

    print("\nDaily totals used in calculation (latest per day):")
    total_sum = 0
    for date_obj in sorted(daily_latest_entries.keys()):
        ts, val = daily_latest_entries[date_obj]
        total_sum += val
        print(f"  {date_obj} (from {ts}): {val}")

    print(f"\nTotal Pump Insulin since site change ({site_change_date}): {total_sum:.2f}")

if __name__ == "__main__":
    calculate_insulin()
