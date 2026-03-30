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
        sync_str = record.get('syncTimestamp') or record.get('lastSync')
        
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

    # Find the latest insulin entry and calculate daily latest entries
    daily_latest_entries = {}
    baseline_entry = None # (timestamp_string, insulin_total)
    all_insulin_entries = [] # list of (datetime, total_insulin)
    alarms = [] # list of datetimes

    for record in data:
        # Check for alarms
        alarm_text = record.get('alarm')
        if alarm_text and "Insulin levels remaining in Pod are low" in alarm_text:
            created_at = record.get('created_at')
            if created_at:
                alarms.append(datetime.fromisoformat(created_at.replace('Z', '+00:00')))

        insulin_data = record.get('InsulinPerDay', [])
        for entry in insulin_data:
            ts_str = entry.get('timestamp')
            total = entry.get('totalPumpInsulinPerDay')
            
            if ts_str and total is not None:
                ts_dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                all_insulin_entries.append((ts_dt, total))
                
                # Check for baseline (immediately on or before site change)
                if ts_dt <= latest_site_change:
                    if baseline_entry is None or ts_str > baseline_entry[0]:
                        baseline_entry = (ts_str, total)
                
                # Group for daily totals (on or after site change date)
                ts_date = ts_dt.date()
                if ts_date >= site_change_date:
                    current_stored = daily_latest_entries.get(ts_date)
                    if current_stored is None or ts_str > current_stored[0]:
                        daily_latest_entries[ts_date] = (ts_str, total)

    if baseline_entry:
        print(f"Baseline entry (on/before site change): {baseline_entry[0]} = {baseline_entry[1]}")
    else:
        print("No baseline entry found on or before site change.")
        baseline_entry = ("", 0.0)

    print("\nDaily totals (latest per day):")
    gross_sum = 0
    for date_obj in sorted(daily_latest_entries.keys()):
        ts, val = daily_latest_entries[date_obj]
        gross_sum += val
        print(f"  {date_obj} (from {ts}): {val}")

    net_total = gross_sum - baseline_entry[1]

    print(f"\nGross Total: {gross_sum:.2f}")
    print(f"Baseline to subtract: {baseline_entry[1]:.2f}")
    print(f"Net Pump Insulin since site change ({latest_site_change}): {net_total:.2f}")

    if alarms:
        print("\nLow Insulin Alarms Correlated with Pump Total:")
        # Sort insulin entries by time for correlation
        all_insulin_entries.sort(key=lambda x: x[0])
        for alarm_dt in sorted(alarms):
            # Find the latest insulin entry <= alarm_dt
            best_match = None
            for ins_dt, ins_total in all_insulin_entries:
                if ins_dt <= alarm_dt:
                    best_match = (ins_dt, ins_total)
                else:
                    break
            
            if best_match:
                print(f"  Alarm at {alarm_dt.isoformat()} -> Insulin total {best_match[1]:.2f} (from {best_match[0].isoformat()})")
            else:
                print(f"  Alarm at {alarm_dt.isoformat()} -> No insulin data found on or before alarm.")

if __name__ == "__main__":
    calculate_insulin()
