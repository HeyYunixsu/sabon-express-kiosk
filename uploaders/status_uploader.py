import os
import socket
import time
import json
import logging # For logging errors to a file
import datetime

from pathlib import Path
from dotenv import load_dotenv

current_dir = Path(__file__).parent
env_path = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)

# --- Configuration matching your C++ Server ---
SERVER_IP = os.getenv("SOCKET_IP", "127.0.0.1")
SERVER_PORT = os.getenv("SOCKET_PORT", "8080")
BUFFER_SIZE = 1024

machineId = os.getenv("machineId", "1")

SERVER_PORT = int(SERVER_PORT)
machineId = int(machineId)

# --- Reconnection settings ---
RECONNECT_DELAY_SECONDS = 30 # Time to wait before attempting to reconnect

BASE_URL = os.getenv("API_BASE_URL", "https://office.dynamicglobalsoft.com:1232")

# --- Logging setup ---
# Configure logging to console and a file
logging.basicConfig(
    level=logging.INFO, # Or logging.DEBUG, logging.WARNING etc.
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("client_errors.log"), # Log to a file
        logging.StreamHandler() # Also log to console
    ]
)

# Must match TOTAL_SLOTS in controller/includes/hardware_config.h.
TOTAL_SLOTS = 6

# STATUS layout (see build_status_response in controller/src/socket_server.cpp):
#   [0]="STATUS", then armedQty, remaining, wlvl, busy, queueDepth
#   (TOTAL_SLOTS values each), then paused, phase, bundleComplete.
WLVL_START = 1 + 2 * TOTAL_SLOTS          # first water-level field index
WLVL_END = WLVL_START + TOTAL_SLOTS       # one past the last
STATUS_FIELD_COUNT = 5 * TOTAL_SLOTS + 4  # total fields in a well-formed line

water_level_data = ["-1"] * TOTAL_SLOTS

def preprocess_data(sensor_reading_string):
    # controller sends "STATUS,<fields...>" — index by position rather than by
    # a negative slice, so adding fields to the tail cannot silently shift
    # which values get read as water levels.
    if not sensor_reading_string.startswith("STATUS,"):
        return None, False
    global water_level_data
    print(sensor_reading_string)

    parts = sensor_reading_string.split(',')
    if len(parts) < STATUS_FIELD_COUNT:
        logging.warning(
            f"  [API Sender] Short STATUS line "
            f"({len(parts)} fields, expected {STATUS_FIELD_COUNT}) - ignoring."
        )
        return None, False

    current_datetime = datetime.datetime.now()
    buffer_water_level_data = [f.strip() for f in parts[WLVL_START:WLVL_END]]

    hasChange = any(
        buffer_water_level_data[i] != water_level_data[i]
        for i in range(TOTAL_SLOTS)
    )
    if hasChange:
        data = []
        for i in range(TOTAL_SLOTS):
            water_level_data[i] = buffer_water_level_data[i]
            data.append({
                "machineId":machineId,
                "status": "ACTIVE",
                "levels": "NORMAL" if (water_level_data[i] == 0 or water_level_data[i] == '0') else "CRITICAL",
                "slot":(i + 1),
                "dateReported":current_datetime.strftime("%Y-%m-%d %H:%M:%S")
            })
        return {"status":data}, True
    else:
        return None, False
    
def send_data_to_api(sensor_reading_string):
    """
    Simulates sending sensor data to an external API.
    (Same as previous code, not repeating full body here for brevity)
    """
    # logging.info(f"[API Sender] Simulating API call with data: '{sensor_reading_string}'")
    try:
        # A single recv() can carry several STATUS lines, or none - handle
        # each line on its own so a batched read is not silently dropped.
        for line in sensor_reading_string.splitlines():
            line = line.strip()
            if not line:
                continue
            api_payload, isValid = preprocess_data(line)
            # print(api_payload)
            if isValid:
                if api_payload:
                    logging.info(f"  [API Sender] Data prepared for API:\n{json.dumps(api_payload, indent=2)}")
                    send_machine_status_api(BASE_URL, api_payload)
                else:
                    logging.warning(f"  [API Sender] Could not parse sensor data string. Sending raw data.")
    except Exception as e:
        logging.error(f"  [API Sender ERROR] An unexpected error occurred during API sending simulation: {e}")

import requests
import json # Used here for pretty-printing the request body in the example

def send_machine_status_api(base_url: str, data_payload: dict | list) -> requests.Response | None:
    """
    Sends a POST request with JSON data to the /api/send/data/here endpoint.

    Args:
        base_url (str): The base URL of your API (e.g., "http://localhost:8000" or "https://your.api.com").
        data_payload (dict | list): The Python dictionary or list of dictionaries
                                    that you want to send as the JSON body.

    Returns:
        requests.Response | None: The response object from the API if the request was successful
                                  (status code 2xx), otherwise None.
    """
    endpoint = "/api/v1/auth/machine/status"
    full_url = f"{base_url}{endpoint}"

    print(f"Attempting to POST to: {full_url}")
    print(f"Request Body (JSON): {json.dumps(data_payload, indent=2)}") # For debugging

    try:
        # The 'json' parameter automatically serializes the Python object to JSON
        # and sets the 'Content-Type: application/json' header.
        response = requests.post(full_url, json=data_payload, timeout=10)

        # .raise_for_status() will throw an HTTPError for 4xx or 5xx responses,
        # which helps in robust error handling.
        response.raise_for_status()

        print(f"API Response Status Code: {response.status_code}")
        print(f"API Response Body: {response.text}")
        return response

    except requests.exceptions.HTTPError as e:
        print(f"HTTP Error: An error status code was received. Status: {e.response.status_code}, Body: {e.response.text}")
        return None
    except requests.exceptions.ConnectionError as e:
        print(f"Connection Error: Could not connect to the API server. Is it running? {e}")
        return None
    except requests.exceptions.Timeout as e:
        print(f"Timeout Error: The request took too long and timed out. {e}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"An unexpected error occurred during the API request: {e}")
        return None
    except Exception as e:
        print(f"An unknown error occurred: {e}")
        return None



def run_python_client_with_reconnect():
    while True: # Outer loop for continuous reconnection attempts
        client_socket = None
        try:
            client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            logging.info(f"Python client: Attempting to connect to C++ server at {SERVER_IP}:{SERVER_PORT}...")
            client_socket.connect((SERVER_IP, SERVER_PORT))
            logging.info("Python client: Successfully connected to C++ server!")

            # Set socket to non-blocking (optional but good practice for continuous apps)
            # client_socket.setblocking(False)

            while True: # Inner loop for active communication
                try:
                    data = client_socket.recv(BUFFER_SIZE).decode('utf-8')
                    if not data:
                        logging.warning("Python client: C++ server disconnected gracefully. Attempting to reconnect...")
                        break # Break inner loop, outer loop will retry
                    
                    # logging.info(f"Python client: Received from C++ server: '{data.strip()}'")
                    send_data_to_api(data.strip())

                except socket.error as e:
                    # Handle non-blocking socket errors (e.g., no data available right now)
                    if e.errno == socket.errno.EAGAIN or e.errno == socket.errno.EWOULDBLOCK:
                        time.sleep(0.01) # Small sleep to prevent busy-waiting
                        continue # Continue to next iteration of inner loop
                    else:
                        logging.error(f"Python client: Socket error during receive ({e.errno}): {e}. Attempting to reconnect...")
                        break # Break inner loop due to critical socket error
                except Exception as e:
                    logging.error(f"Python client: An unexpected error occurred during communication: {e}. Attempting to reconnect...")
                    break # Break inner loop for any other unexpected error
                
                time.sleep(0.05) # Small delay to prevent busy-looping

        except socket.error as e:
            logging.error(f"Python client: Connection failed ({e.errno}): {e}. Retrying in {RECONNECT_DELAY_SECONDS} seconds...")
            # This is where the initial connection failure is caught
        except Exception as e:
            logging.critical(f"Python client: A critical error occurred before connection or during setup: {e}. Retrying...")
        finally:
            if client_socket:
                client_socket.close()
                logging.info("Python client: Socket closed.")
        
        # This sleep happens after any connection failure or disconnection
        time.sleep(RECONNECT_DELAY_SECONDS)

if __name__ == "__main__":
    run_python_client_with_reconnect()