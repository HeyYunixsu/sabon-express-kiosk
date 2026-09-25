#include "socket_server.h"
// voucher_manager removed — per-slot armed state used instead
#include "utils.h"
#include "pump_control.h"
#include <iostream>
#include <cstring>
#include <algorithm>
#include <map>
#include <chrono>

#ifdef _WIN32
#include <ws2tcpip.h>
#define CLOSESOCKET(s) closesocket(s)
#define GET_LAST_SOCKET_ERROR() WSAGetLastError()
#define SOCKET_ERROR_WOULDBLOCK WSAEWOULDBLOCK
#else
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <arpa/inet.h>
#define CLOSESOCKET(s) close(s)
#define GET_LAST_SOCKET_ERROR() errno
#define SOCKET_ERROR_WOULDBLOCK EAGAIN
#endif

// --- Constants ---
const int MAX_BUFFER_SIZE = 1024;
const int MAX_ARM_QTY     = 100;
const int LISTEN_BACKLOG  = 5;

SocketHandle g_server_listening_socket = (SocketHandle)-1;
std::vector<SocketHandle> g_connected_client_sockets;
sockaddr_in g_server_address_info;
socklen_t g_server_addrlen = sizeof(g_server_address_info);

// --- Helpers ---

int socket_count_commas(const char *s)
{
  int n = 0;
  while (*s) { if (*s++ == ',') n++; }
  return n;
}

bool isFirstWordTest(const char *str, const char *target_word)
{
  size_t target_word_len = std::strlen(target_word);
  if (std::strlen(str) < target_word_len || std::strncmp(str, target_word, target_word_len) != 0)
    return false;

  char char_after_word = str[target_word_len];
  return (char_after_word == '\0'
       || std::isspace(static_cast<unsigned char>(char_after_word))
       || char_after_word == ',');
}

void set_socket_non_blocking(SocketHandle sock)
{
#ifdef _WIN32
  u_long mode = 1;
  if (ioctlsocket(sock, FIONBIO, &mode) != 0)
    log_error("socket", "Error setting non-blocking: " + std::to_string(GET_LAST_SOCKET_ERROR()));
#else
  int flags = fcntl(sock, F_GETFL, 0);
  if (flags != -1) fcntl(sock, F_SETFL, flags | O_NONBLOCK);
#endif
}

bool initialize_socket_environment()
{
#ifdef _WIN32
  WSADATA wsaData;
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
  {
    log_error("socket", "WSAStartup failed");
    return false;
  }
#endif
  return true;
}

bool create_and_bind_server_socket(int port)
{
  g_server_listening_socket = socket(AF_INET, SOCK_STREAM, 0);
  if (g_server_listening_socket == (SocketHandle)-1)
  {
    log_error("socket", "Failed to create socket");
    return false;
  }

  int opt = 1;
  setsockopt(g_server_listening_socket, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));

  g_server_address_info.sin_family = AF_INET;
  g_server_address_info.sin_addr.s_addr = INADDR_ANY;
  g_server_address_info.sin_port = htons(static_cast<uint16_t>(port));

  if (bind(g_server_listening_socket, (struct sockaddr *)&g_server_address_info, sizeof(g_server_address_info)) < 0)
  {
    log_error("socket", "bind() failed on port " + std::to_string(port));
    CLOSESOCKET(g_server_listening_socket);
    return false;
  }
  return true;
}

bool start_listening_for_connections()
{
  if (listen(g_server_listening_socket, LISTEN_BACKLOG) < 0)
  {
    log_error("socket", "listen() failed");
    CLOSESOCKET(g_server_listening_socket);
    return false;
  }
  set_socket_non_blocking(g_server_listening_socket);
  log_info("socket", "Listening on port " + std::to_string(ntohs(g_server_address_info.sin_port)));
  return true;
}

static std::string build_status_response(AppState &state)
{
  // STATUS format (34 comma-separated fields for TOTAL_SLOTS = 6):
  //   "STATUS", armedQty1-6, remaining1-6, wlvl1-6, busy1-6, queueDepth1-6,
  //   paused, phase, bundleComplete
  // Field count is 5 * TOTAL_SLOTS + 4 — keep the dashboard parser
  // (public/index.html) and status_uploader.py in sync when this changes.
  std::string resp = "STATUS";
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    resp += "," + std::to_string(state.armedQty[i]);
  }
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    resp += "," + std::to_string(state.remainingTime[i]);
  }
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    resp += "," + std::to_string(state.slotEmpty[i] ? 1 : 0);
  }
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    resp += "," + std::to_string(state.slotBusy[i] ? 1 : 0);
  }
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    resp += "," + std::to_string((int)state.pendingQueue[i].size());
  }
  resp += "," + std::to_string(state.paused ? 1 : 0);
  resp += "," + std::to_string(static_cast<int>(state.phase));
  resp += "," + std::to_string(state.bundleComplete ? 1 : 0);
  // Newline-terminated: TCP is a byte stream with no message boundaries, and
  // every consumer (server.js, status_uploader.py) already splits on newlines.
  // Without this, two STATUS lines arriving in one recv() are parsed as one
  // and the second is silently dropped.
  resp += "\n";
  return resp;
}

void accept_new_client_connections(AppState &state)
{
  SocketHandle new_client_socket;
  while (true)
  {
    new_client_socket = accept(g_server_listening_socket,
                               (struct sockaddr *)&g_server_address_info,
                               &g_server_addrlen);
#ifdef _WIN32
    if (new_client_socket == INVALID_SOCKET) break;
#else
    if (new_client_socket == -1) break;
#endif
    set_socket_non_blocking(new_client_socket);
    g_connected_client_sockets.push_back(new_client_socket);
    log_info("socket", "New client: " + std::to_string((int)new_client_socket));

    // Push current state immediately so the GUI doesn't wait for the first
    // 5-second ACK before displaying data.
    std::string initial_status = build_status_response(state);
    send(new_client_socket, initial_status.c_str(), initial_status.length(), 0);
  }
}

static void broadcast_status(AppState &state)
{
  std::string msg = build_status_response(state);
  for (SocketHandle sock : g_connected_client_sockets)
  {
    // A client that never drains its socket will eventually fill the kernel
    // buffer and make this fail. Silence there looks like a dead sensor, so
    // say so rather than dropping the update without a trace.
    int sent = (int)send(sock, msg.c_str(), msg.length(), 0);
    if (sent < 0)
      log_error("socket", "STATUS broadcast failed (client not reading?)");
  }
}

// Per-client receive buffers. TCP is a byte stream with no message
// boundaries: one recv() can carry several commands, or half of one. Bytes
// accumulate here and only complete newline-terminated lines are dispatched.
static std::map<SocketHandle, std::string> g_client_buffers;

// Largest partial line held for one client. A sender that never emits a
// newline must not be able to grow this without bound.
static const size_t MAX_CLIENT_BUFFER = 8192;

static void process_command(AppState &state, const std::string &line,
                            SocketHandle current_client_socket)
{
  const char *client_buffer = line.c_str();
  try
  {
      if (isFirstWordTest(client_buffer, "ARM_BATCH"))
      {
        // Format: ARM_BATCH,<slot1>:<qty1>,<slot2>:<qty2>,...
        // Arms all specified slots simultaneously from a single sale.
        std::string input_str(client_buffer);
        size_t start = input_str.find(',');
        if (start == std::string::npos) {
          log_error("socket", "Malformed ARM_BATCH: no slots");
        } else {
          std::string payload = input_str.substr(start + 1);
          int armed = 0;
          size_t pos = 0;
          while (pos < payload.length()) {
            size_t colon = payload.find(':', pos);
            size_t comma = payload.find(',', colon);
            if (colon == std::string::npos) break;
            int slot = std::stoi(payload.substr(pos, colon - pos));
            int qty  = std::stoi(payload.substr(colon + 1, comma == std::string::npos ? std::string::npos : comma - colon - 1));
            if (slot >= 1 && slot <= TOTAL_SLOTS && qty > 0 && qty <= MAX_ARM_QTY) {
              if (state.slotBusy[slot]) {
                state.pendingQueue[slot].push(PendingArm(slot, qty));
              } else {
                state.armedQty[slot] += qty;
                armed++;
              }
            }
            if (comma == std::string::npos) break;
            pos = comma + 1;
          }
          if (armed > 0) {
            state.phase = TxnPhase::ARMED;
            state.bundleComplete = false;
          }
          log_info("socket", "ARM_BATCH: " + std::to_string(armed) + " slots armed");
          broadcast_status(state);
          saveStateToDisk(state, state.transactionDir);
        }
      }
      else if (isFirstWordTest(client_buffer, "ARM"))
      {
        if (socket_count_commas(client_buffer) != 2)
        {
          log_error("socket", std::string("Malformed ARM (expected 2 commas): ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t p1 = input_str.find(',');
          size_t p2 = input_str.find(',', p1 + 1);
          int productId = std::stoi(input_str.substr(p1 + 1, p2 - (p1 + 1)));
          int qty = std::stoi(input_str.substr(p2 + 1));

          if (productId < 1 || productId > TOTAL_SLOTS)
          {
            log_error("socket", std::string("ARM rejected — invalid product ID: ") + std::to_string(productId));
          }
          else if (qty <= 0 || qty > MAX_ARM_QTY)
          {
            log_error("socket", std::string("ARM rejected — invalid qty: ") + std::to_string(qty));
          }
          else if (state.slotBusy[productId])
          {
            // Slot is busy — queue the request
            state.pendingQueue[productId].push(PendingArm(productId, qty));
            log_info("socket", "ARM queued for busy slot " + std::to_string(productId) +
                     "  qty=" + std::to_string(qty) +
                     "  queueDepth=" + std::to_string((int)state.pendingQueue[productId].size()));
          }
          else
          {
            state.armedQty[productId] += qty;
            state.phase = TxnPhase::ARMED;
            state.bundleComplete = false;
            log_info("socket", "ARM accepted  product=" + std::to_string(productId) +
                     "  qty=" + std::to_string(qty) +
                     "  totalArmed=" + std::to_string(state.armedQty[productId]));
          }
          broadcast_status(state);
          saveStateToDisk(state, state.transactionDir);
        }
      }
      else if (isFirstWordTest(client_buffer, "SETPRICE"))
      {
        // SETPRICE,<slot>,<pesos> -- prices are set per client, so they are
        // editable rather than compiled in. Every change is audited by the
        // controller, because it silently changes what all future sales are
        // worth and that is exactly the lever someone skimming would reach for.
        if (socket_count_commas(client_buffer) != 2)
        {
          log_error("socket", std::string("Malformed SETPRICE (expected 2 commas): ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t p1 = input_str.find(',');
          size_t p2 = input_str.find(',', p1 + 1);
          int slot  = std::stoi(input_str.substr(p1 + 1, p2 - (p1 + 1)));
          int pesos = std::stoi(input_str.substr(p2 + 1));

          PriceResult r = pump_set_price(state, slot, pesos);
          std::string result = price_result_text(r);

          if (r == PriceResult::OK)
            log_info("socket", "SETPRICE slot " + std::to_string(slot)
                     + " = " + std::to_string(pesos));
          else
            log_error("socket", "SETPRICE slot " + std::to_string(slot)
                      + " refused: " + result);

          std::string ack = "PRICE_ACK," + std::to_string(slot) + "," + result + "\n";
          send(current_client_socket, ack.c_str(), ack.length(), 0);
        }
      }
      else if (isFirstWordTest(client_buffer, "GETPRICES"))
      {
        // The controller is the single source of truth for prices: it resolves
        // defaults, config.env and the saved file in that order. The dashboard
        // asks rather than re-implementing that precedence and drifting.
        std::string resp = "PRICES";
        for (int i = 1; i <= TOTAL_SLOTS; i++)
          resp += "," + std::to_string(pump_get_price(i));
        resp += "\n";
        send(current_client_socket, resp.c_str(), resp.length(), 0);
      }
      else if (isFirstWordTest(client_buffer, "PRIME"))
      {
        // PRIME,<slot> -- run one pump for a short fixed burst to push air out
        // of the hose after a gallon change, so the next customer is not
        // charged for a press that dispenses nothing.
        //
        // A fixed burst rather than hold-to-run: a held button over Wi-Fi is a
        // dead-man's switch that fails open. Drop the link mid-hold and the
        // release never arrives, leaving the pump running unattended.
        //
        // This deliberately records no sale, so the controller appends a
        // non-revenue record instead of leaving no trace at all.
        if (socket_count_commas(client_buffer) != 1)
        {
          log_error("socket", std::string("Malformed PRIME (expected 1 comma): ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          int slot = std::stoi(input_str.substr(input_str.find(',') + 1));
          PrimeResult r = pump_start_prime(state, slot);
          std::string result = prime_result_text(r);

          if (r == PrimeResult::STARTED)
            log_info("socket", "PRIME slot " + std::to_string(slot) + ": started");
          else
            log_info("socket", "PRIME slot " + std::to_string(slot) + " refused: " + result);

          // Answer the caller directly. Without this the dashboard cannot tell
          // a refusal from a lost packet, and staff retry blindly.
          std::string ack = "PRIME_ACK," + std::to_string(slot) + "," + result + "\n";
          send(current_client_socket, ack.c_str(), ack.length(), 0);
          broadcast_status(state);
        }
      }
      else if (isFirstWordTest(client_buffer, "CANCEL_ALL"))
      {
        int total = 0;
        for (int i = 1; i <= TOTAL_SLOTS; i++) {
          int lost = state.armedQty[i];
          while (!state.pendingQueue[i].empty()) {
            lost += state.pendingQueue[i].front().qty;
            state.pendingQueue[i].pop();
          }
          // One row per slot, not one for the batch: the price differs per
          // product, so a single total could not be reconciled back.
          pump_record_unclaimed(state, i, lost, "cancelled");
          state.armedQty[i] = 0;
          total += lost;
        }
        if (!state.anyArmed()) { state.phase = TxnPhase::IDLE; state.bundleComplete = false; }
        log_info("socket", "CANCEL_ALL: cleared " + std::to_string(total) + " credits");
        broadcast_status(state);
        saveStateToDisk(state, state.transactionDir);
      }
      else if (isFirstWordTest(client_buffer, "CANCEL_QUEUE"))
      {
        // CANCEL_QUEUE,<productId>
        if (socket_count_commas(client_buffer) != 1)
        {
          log_error("socket", std::string("Malformed CANCEL_QUEUE: ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t p1 = input_str.find(',');
          int productId = std::stoi(input_str.substr(p1 + 1));
          if (productId >= 1 && productId <= TOTAL_SLOTS) {
            // Queued credits were paid for exactly like the armed ones. The
            // armed credits do survive this command, but throwing the queue
            // away without a record is the same hole in a quieter place.
            int lost = 0;
            while (!state.pendingQueue[productId].empty()) {
              lost += state.pendingQueue[productId].front().qty;
              state.pendingQueue[productId].pop();
            }
            pump_record_unclaimed(state, productId, lost, "cancelled");
            log_info("socket", "CANCEL_QUEUE slot " + std::to_string(productId)
                      + ": cleared " + std::to_string(lost) + " queued credits");
            broadcast_status(state);
          }
        }
      }
      else if (isFirstWordTest(client_buffer, "CANCEL"))
      {
        // CANCEL,<productId>
        if (socket_count_commas(client_buffer) != 1)
        {
          log_error("socket", std::string("Malformed CANCEL: ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t p1 = input_str.find(',');
          int productId = std::stoi(input_str.substr(p1 + 1));
          if (productId >= 1 && productId <= TOTAL_SLOTS) {
            int lost = state.armedQty[productId];
            while (!state.pendingQueue[productId].empty()) {
              lost += state.pendingQueue[productId].front().qty;
              state.pendingQueue[productId].pop();
            }
            pump_record_unclaimed(state, productId, lost, "cancelled");

            state.armedQty[productId] = 0;
            if (!state.anyArmed()) { state.phase = TxnPhase::IDLE; state.bundleComplete = false; }
            log_info("socket", "CANCEL slot " + std::to_string(productId)
                      + ": cleared " + std::to_string(lost) + " credits");
            broadcast_status(state);
            saveStateToDisk(state, state.transactionDir);
          }
        }
      }
      else if (isFirstWordTest(client_buffer, "WTRLVL"))
      {
        // "WTRLVL,v1,...,vN" — N is TOTAL_SLOTS (current wiring, one sensor
        // per slot) or the legacy 4, so an un-upgraded
        // water_level_monitoring.py keeps working. Slots past N are
        // treated as "has liquid" so they are never blocked from dispensing.
        // Any other count is malformed and ignored.
        const int LEGACY_SENSOR_COUNT = 4;
        int sensorCount = socket_count_commas(client_buffer);
        if (sensorCount != TOTAL_SLOTS && sensorCount != LEGACY_SENSOR_COUNT)
        {
          log_error("socket", std::string("Malformed WTRLVL (expected ")
              + std::to_string(LEGACY_SENSOR_COUNT) + " or "
              + std::to_string(TOTAL_SLOTS) + " commas, got "
              + std::to_string(sensorCount) + "): " + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t start = input_str.find(',') + 1;
          std::string summary;

          // water_level_monitoring.py forwards the raw GPIO reading, so
          // which level means "empty" depends on how the sensors are wired.
          // WATER_SENSOR_EMPTY_HIGH (config.env) selects it without a rebuild.
          const std::string emptyLevel = WATER_SENSOR_EMPTY_HIGH ? "1" : "0";

          for (int slot = 1; slot <= TOTAL_SLOTS; slot++) {
            if (slot <= sensorCount) {
              size_t end = input_str.find(',', start);
              std::string field = trim(end == std::string::npos
                  ? input_str.substr(start)
                  : input_str.substr(start, end - start));
              state.slotEmpty[slot] = (field == emptyLevel);
              start = (end == std::string::npos) ? input_str.size() : end + 1;
            } else {
              state.slotEmpty[slot] = false;  // no sensor wired for this slot
            }
            summary += " s" + std::to_string(slot) + "="
                     + (state.slotEmpty[slot] ? "E" : "ok");
          }

          // Only log transitions. The sensor script sends WTRLVL once a
          // second and the reading is almost always identical, so logging
          // every one wrote ~86,400 near-duplicate lines a day per machine --
          // enough to fill the SD card, wear it out, and bury real events.
          static std::string last_water_summary;
          if (summary != last_water_summary)
          {
            log_info("socket", "Water level:" + summary);
            last_water_summary = summary;
          }
          broadcast_status(state);
        }
      }
      else
      {
        // Any unrecognised command (e.g. "Client ACK") triggers a STATUS response
        std::string data_to_send = build_status_response(state);
        send(current_client_socket, data_to_send.c_str(), data_to_send.length(), 0);
      }
  }
  catch (const std::exception &e)
  {
    log_error("socket", std::string("Command parse error (") + client_buffer + "): " + e.what());
  }
}

void manage_connected_clients(AppState &state)
{
  char chunk[MAX_BUFFER_SIZE];

  for (auto it = g_connected_client_sockets.begin(); it != g_connected_client_sockets.end();)
  {
    SocketHandle current_client_socket = *it;
    int bytes_received = recv(current_client_socket, chunk, MAX_BUFFER_SIZE - 1, 0);

    if (bytes_received <= 0)
    {
#ifdef _WIN32
      if (bytes_received == SOCKET_ERROR && GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK)
      { ++it; continue; }
#else
      if (bytes_received == -1 && GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK)
      { ++it; continue; }
#endif
      CLOSESOCKET(current_client_socket);
      g_client_buffers.erase(current_client_socket);
      it = g_connected_client_sockets.erase(it);
      continue;
    }

    std::string &buf = g_client_buffers[current_client_socket];
    buf.append(chunk, (size_t)bytes_received);

    size_t newline_pos;
    while ((newline_pos = buf.find('\n')) != std::string::npos)
    {
      std::string line = trim(buf.substr(0, newline_pos));
      buf.erase(0, newline_pos + 1);
      if (!line.empty()) process_command(state, line, current_client_socket);
    }

    if (buf.size() > MAX_CLIENT_BUFFER)
    {
      log_error("socket", "Discarding " + std::to_string(buf.size())
          + " buffered bytes from a client that sent no newline");
      buf.clear();
    }

    ++it;
  }
}

void cleanup_socket_environment()
{
  for (SocketHandle sock : g_connected_client_sockets) CLOSESOCKET(sock);
  g_connected_client_sockets.clear();
  g_client_buffers.clear();
  if (g_server_listening_socket != (SocketHandle)-1)
  {
    CLOSESOCKET(g_server_listening_socket);
    g_server_listening_socket = (SocketHandle)-1;
  }
#ifdef _WIN32
  WSACleanup();
#endif
}

void server_app_setup(AppState &state)
{
  if (!initialize_socket_environment()) return;
  if (!create_and_bind_server_socket(state.serverPort)) return;
  start_listening_for_connections();
}

void server_app_loop(AppState &state)
{
  accept_new_client_connections(state);
  manage_connected_clients(state);

  // Broadcast STATUS every 500 ms so the GUI timer stays in sync without
  // waiting for a "Client ACK" (which arrives every 5 seconds).
  static auto last_broadcast = std::chrono::steady_clock::now() - std::chrono::seconds(1);
  auto now_bc = std::chrono::steady_clock::now();
  if (std::chrono::duration_cast<std::chrono::milliseconds>(now_bc - last_broadcast).count() >= 500) {
    last_broadcast = now_bc;
    broadcast_status(state);
  }
}
