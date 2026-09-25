import os
import time
import json
import requests
import shutil
import itertools


from pathlib import Path
from dotenv import load_dotenv

current_dir = Path(__file__).parent
env_path = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)

BASE_URL = os.getenv("API_BASE_URL", "https://office.dynamicglobalsoft.com:1232")

api_endpoint = f"{BASE_URL}/api/v1/auth/machine/transaction"

# Where confirmed sales are kept locally, one JSON object per line, one file
# per month. Without this the machine has no memory of its own trading: every
# record is deleted the moment the cloud accepts it, so the transaction
# directory is empty seconds after a sale and nothing can answer "what sold
# today" on site or if the client ever leaves the service.
#
# Written here rather than in the controller on purpose. What lands in the
# archive is exactly what the cloud acknowledged, so the two cannot drift.
SALES_ARCHIVE_DIR = os.getenv(
    "SALES_ARCHIVE_DIR",
    str(current_dir / ".." / "logs" / "sales"),
)

# Where the controller drops each sale. This used to be the bare relative path
# "../transaction", which ignored TRANSACTION_DIR entirely -- so the one key the
# install guide insists you set correctly did nothing here, and the uploader
# silently depended on being launched from the right working directory.
#
# On a fresh Pi the directory does not exist at all: git cannot store an empty
# directory, and the controller only creates it when it writes its first sale.
# The uploader would then exit on FileNotFoundError and PM2 would restart it in
# a loop until somebody happened to make a sale.
TRANSACTION_DIR = os.getenv(
    "TRANSACTION_DIR",
    str(current_dir / ".." / "transaction"),
)


def archive_sale(record):
    """Append one confirmed sale to this month's archive.

    Never raises: a machine that cannot write its archive must keep selling
    and keep uploading. A failure here costs a line of local history, and
    stopping the till would cost the day's trade.
    """
    try:
        os.makedirs(SALES_ARCHIVE_DIR, exist_ok=True)
        # Group by the sale's own date, not today's, so a record uploaded
        # after a night offline lands in the month it was actually sold.
        month = str(record.get("dateCreated", ""))[:7] or time.strftime("%Y-%m")
        path = os.path.join(SALES_ARCHIVE_DIR, f"sales-{month}.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "machine_id":   record.get("machineId"),
                "slot":         record.get("slot"),
                "amount":       record.get("amount"),
                "date_created": record.get("dateCreated"),
            }) + "\n")
    except Exception as archive_error:
        print(f"Could not archive sale locally: {archive_error}")

def send_data_to_api(api_url, data_payload):
    """
    Sends data as a JSON payload in a POST request to a REST API.

    Args:
        api_url (str): The URL of the REST API endpoint.
        data_payload (dict): A Python dictionary containing the data to send in the request body.

    Returns:
        requests.Response or None: The response object from the API if the request was successful,
                                     None otherwise. You can then access response.status_code,
                                     response.json(), response.text, etc.
    """
    print(f"Sending POST request to SERVER at {BASE_URL}...")

    # Bound before the try so the handler below can safely test it. requests.post
    # raises on a refused connection, which leaves this name unassigned -- the
    # except block then died with UnboundLocalError, throwing out of this
    # function instead of returning None, and losing the server's error body
    # at the exact moment it was worth reading.
    response = None

    try:
        headers = {'Content-Type': 'application/json'}
        # Without a timeout a half-open connection blocks this loop forever with
        # no log line: sales quietly stop uploading and nothing says why.
        response = requests.post(api_url, headers=headers,
                                 data=json.dumps(data_payload), timeout=30)

        # Raise an exception for bad status codes (4xx or 5xx)
        response.raise_for_status()

        print(f"POST request successful. Status Code: {response.status_code}")
        return response

    except requests.exceptions.RequestException as e:
        print(f"Error sending POST request: {e}")
        if response is not None:
            print(f"Response Status Code: {response.status_code}")
            try:
                print(f"Response Body: {response.json()}")
            except json.JSONDecodeError:
                print(f"Response Body (Text): {response.text}")
        return None


def analyze_file_content(source_path):
    """
    Reads and processes the content of a given file.
    Replace this with your specific file analysis logic.
    """
    print(f"Analyzing file: {source_path}")
    json_data = None
    try:
        json_data = dict()
        with open(source_path, 'r') as file:
            data_payload = file.read()
            print(f"File data:\n{data_payload}")
        # Your data processing/analysis steps here
            json_data : dict = json.loads(data_payload)

        # Replace with the actual data you want to send
        record = {
            "machineId": json_data["machine_id"],
            "vendorId": json_data["vendor_id"],
            "slot": json_data["slot"],
            "amount": json_data["amount"],
            "dateCreated": json_data["date_created"]
        }
        if (json_data.get("voucher_id", None)):
            record["voucherId"] = json_data["voucher_id"]
        
        return record, True
    except Exception as processing_error:
        print(f"Error during file analysis of {source_path}: {processing_error}")
        return None, False

def track_incoming_files(watch_directory):
    """
    Continuously monitors a directory for new files, processes them, and manages their lifecycle.
    """
    global api_endpoint
    
    print(f"Observing directory: {watch_directory}")
    failed_files = []
    
    while True:
        try:
            # available_files = [item for item in os.listdir(watch_directory) if os.path.isfile(os.path.join(watch_directory, item))]
            available_files = list(itertools.islice(
                (entry.name for entry in os.scandir(watch_directory) if entry.is_file() and entry.name not in failed_files),
                20
            ))
            
            if available_files:
                records = []
                for filename in available_files:
                    full_path = os.path.join(watch_directory, filename)
                    print(f"Detected new file: {filename}")
                    time.sleep(0.1)

                    listOfData, success = analyze_file_content(full_path)
                    if success:
                        records.append((full_path, listOfData))
                    else:
                        failed_files.append(filename)
                        print(f"File '{filename}' failed to parse — skipping permanently this session.")
                time.sleep(3)
        
                if not records:
                    print("No valid records found in the detected files. Skipping API call.")
                    continue
                
                api_response = send_data_to_api(api_endpoint, {
                    "operations":[record for _, record in records]
                })
                
                response_data = {}
                
                if api_response:
                    try:
                        response_data = api_response.json()
                        print("API Response (JSON):")
                        print(json.dumps(response_data, indent=4))
                    except json.JSONDecodeError:
                        print("API Response (Text):")
                        print(api_response.text)
                
                try:
                    data = response_data.get("data",{"success":[], "failed":[]})
                    # print(type(data))
                    # print(data)

                    for d in data['success']:
                        # print(d)
                        # print(records)
                        paths = [p for p,record in records if str(d["machineId"]) == record["machineId"] and d["dateCreated"] == record["dateCreated"] and d["slot"] == int(record["slot"])]

                        # print(paths)
                        for p in paths:
                            # Archive before deleting. The other order would
                            # lose the sale entirely if the write failed.
                            record = next((r for pp, r in records if pp == p), None)
                            if record:
                                archive_sale(record)
                            os.remove(p)
                            print(f"Source file '{p}' has been deleted.")
                            time.sleep(0.05)
                    for d in data['failed']:
                        paths = [p for p,record in records if str(d["machineId"]) == record["machineId"] and d["dateCreated"] == record["dateCreated"] and d["slot"] == int(record["slot"])]
                        for p in paths:
                            failed_files.append(os.path.basename(p))

                except OSError as deletion_error:
                    print(f"Issue archiving '{full_path}': {deletion_error}")
                
            time.sleep(1)  # Polling interval
        except FileNotFoundError as dir_error:
            # Do not exit. Exiting here made PM2 restart the process in a tight
            # loop until it gave up and marked it errored, which reads as "the
            # uploader is broken" when the real state is "the directory is not
            # there yet". Recreate it and carry on -- a sale written while this
            # process is down would otherwise sit unsent.
            print(f"Directory missing at {watch_directory} - {dir_error}; recreating")
            try:
                os.makedirs(watch_directory, exist_ok=True)
            except Exception as make_error:
                print(f"Could not create {watch_directory}: {make_error}")
            time.sleep(5)
        except Exception as runtime_error:
            print(f"A runtime issue occurred during file tracking: {runtime_error}")
            time.sleep(5)
if __name__ == "__main__":
    # Created up front so a fresh machine does not depend on the controller
    # having made a sale first, and resolved from TRANSACTION_DIR so the
    # uploader and the controller always agree on one directory.
    try:
        os.makedirs(TRANSACTION_DIR, exist_ok=True)
    except Exception as setup_error:
        print(f"Could not create {TRANSACTION_DIR}: {setup_error}")
    track_incoming_files(TRANSACTION_DIR)