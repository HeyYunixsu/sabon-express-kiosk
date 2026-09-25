// test_socket_integration.cpp
//
// Protocol Integration / Behavioral Tests (updated for cashier-dashboard model)
// ---------------------------------------------------------------------------
// These tests exercise the full TCP communication path between the controller
// server and a simulated client.  A real OS socket is bound on a test port
// (9901) and a test-client connects to it, sends protocol messages, and
// verifies both the AppState mutations and the STATUS response payload.
//
// Protocol messages:
//   - Client sends:  "ARM,<productId>,<qty>" / "WTRLVL,0,0,0,0,0,0" / "Client ACK"
//   - Server sends:  "STATUS,<armedQty>,<t>,<wl>,<busy>,<qDepth>  (TOTAL_SLOTS
//                     values each), <pause>,<phase>,<bundleComplete>"
//
// Protocol: plain TCP SOCK_STREAM on 127.0.0.1:9901 (test port, not 8080)

#include "test_framework.h"
#include "socket_server.h"
#include "app_state.h"
#include <thread>
#include <atomic>
#include <chrono>
#include <string>
#include <cstring>
#include <iostream>
#include <sstream>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

// ---------------------------------------------------------------- platform ---

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET ClientSock;
#define INVALID_CLIENT_SOCK INVALID_SOCKET
#define CLOSE_CLIENT(s)     closesocket(s)
#else
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
typedef int ClientSock;
#define INVALID_CLIENT_SOCK (-1)
#define CLOSE_CLIENT(s)     close(s)
#endif

static const int TEST_PORT = 9901;

// ---------------------------------------------------------------- helpers ---

static void yield_to_server()
{
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
}

// Wait until `pred` holds, or give up after timeout_ms.
//
// The server runs on its own thread, so a fixed sleep is a race: under load
// 30ms is not always enough for a command to be parsed and applied. That made
// test_integration_arm_queues_when_slot_busy fail roughly one run in ten,
// which is worse than useless now that CI runs this on every push -- a flaky
// red teaches people to ignore the light.
//
// Only use this where a state change is EXPECTED. Assertions that something
// did NOT change must keep the fixed sleep: waiting for an absence would
// return the instant it looked absent, which is always.
template <typename Pred>
static bool wait_for(Pred pred, int timeout_ms = 2000)
{
    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return pred();
}

static ClientSock connect_test_client()
{
    ClientSock sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock == INVALID_CLIENT_SOCK) return INVALID_CLIENT_SOCK;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(TEST_PORT);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) != 0)
    {
        CLOSE_CLIENT(sock);
        return INVALID_CLIENT_SOCK;
    }
    return sock;
}

// Fire-and-forget command send. Terminates with a newline like every real
// client does, so the server's line framing sees a complete command.
static void send_cmd(ClientSock sock, const std::string &msg)
{
    std::string framed = msg + "\n";
    send(sock, framed.c_str(), (int)framed.length(), 0);
}

// The server frames on newlines, so every command must be terminated. Adding
// it here rather than at each call site keeps the tests honest about the wire
// format without repeating it 20 times.
static std::string send_and_recv(ClientSock sock, const std::string &msg)
{
    std::string framed = msg + "\n";
    send(sock, framed.c_str(), (int)framed.length(), 0);
    yield_to_server();

    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 500;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 500000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    if (n <= 0) return "";
    buf[n] = '\0';
    return std::string(buf);
}

static void drain_connect_push(ClientSock sock)
{
    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 300;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 300000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    recv(sock, buf, sizeof(buf) - 1, 0);
}

// ------------------------------------------------- integration fixture ---

static std::thread          g_server_thread;
static std::atomic<bool>    g_server_running{false};
static AppState             g_test_state;

static void start_integration_server()
{
    g_test_state = AppState{};
    g_test_state.serverPort = TEST_PORT;

    server_app_setup(g_test_state);

    g_server_running = true;
    g_server_thread = std::thread([](){
        while (g_server_running)
        {
            server_app_loop(g_test_state);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
}

static void stop_integration_server()
{
    g_server_running = false;
    if (g_server_thread.joinable()) g_server_thread.join();
    cleanup_socket_environment();
}

// =========================================================================
// TESTS
// =========================================================================

// ---------------------------------- connection + immediate STATUS push ---

void test_integration_client_can_connect()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock != INVALID_CLIENT_SOCK) CLOSE_CLIENT(sock);
}

void test_integration_server_pushes_status_on_connect()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 500;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 500000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    CHECK(n > 0);
    buf[n] = '\0';
    CHECK(std::string(buf).find("STATUS") == 0);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- STATUS response format ---

void test_integration_unknown_command_returns_status()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "Client ACK");
    CHECK(resp.find("STATUS") == 0);

    CLOSE_CLIENT(sock);
}

void test_integration_status_field_count()
{
    // STATUS + five per-slot arrays of TOTAL_SLOTS + paused + phase + bundle.
    // Derived from TOTAL_SLOTS so adding a slot cannot leave this stale.
    const int expectedFields = 5 * TOTAL_SLOTS + 4;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "STATUS");
    std::string body = resp.substr(7);  // skip "STATUS,"
    int commas = 0;
    for (char c : body) if (c == ',') commas++;
    // body holds expectedFields - 1 values, so expectedFields - 2 separators
    CHECK_EQ(commas, expectedFields - 2);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- ARM command ---

void test_integration_arm_increases_armedQty()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send_cmd(sock, "ARM,1,5");
    wait_for([]{ return g_test_state.armedQty[1] == 5; });

    CHECK_EQ((int)g_test_state.armedQty[1], 5);
    CHECK_EQ((int)g_test_state.armedQty[2], 0);  // other slots unaffected
    CLOSE_CLIENT(sock);
}

void test_integration_arm_accumulates_for_same_slot()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send_cmd(sock, "ARM,2,3");
    wait_for([]{ return g_test_state.armedQty[2] == 3; });
    send_cmd(sock, "ARM,2,4");
    wait_for([]{ return g_test_state.armedQty[2] == 7; });

    CHECK_EQ((int)g_test_state.armedQty[2], 7);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_different_slots_independent()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send_cmd(sock, "ARM,1,2");
    wait_for([]{ return g_test_state.armedQty[1] == 2; });
    send_cmd(sock, "ARM,3,4");
    wait_for([]{ return g_test_state.armedQty[3] == 4; });

    CHECK_EQ((int)g_test_state.armedQty[1], 2);
    CHECK_EQ((int)g_test_state.armedQty[3], 4);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_reflected_in_status()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,1,7");
    wait_for([]{ return g_test_state.armedQty[1] == 7; });

    std::string resp = send_and_recv(sock, "STATUS");
    // First field after "STATUS," should be "7"
    CHECK(resp.find("STATUS,7,") == 0);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_arm_is_ignored()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Only 1 comma — needs exactly 2
    send_cmd(sock, "ARM,1");
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_invalid_product_rejected()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Product ID 7 is out of range (valid: 1..TOTAL_SLOTS)
    send_cmd(sock, "ARM,7,1");
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ((int)g_test_state.armedQty[i], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_zero_qty_rejected()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send_cmd(sock, "ARM,1,0");
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_queues_when_slot_busy()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        g_test_state.armedQty[i] = 0;
        while (!g_test_state.pendingQueue[i].empty())
            g_test_state.pendingQueue[i].pop();
    }
    g_test_state.slotBusy[1] = true;  // simulate slot 1 busy

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send_cmd(sock, "ARM,1,3");
    wait_for([]{ return !g_test_state.pendingQueue[1].empty(); });

    // armedQty should NOT increase — it's queued
    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CHECK_EQ((int)g_test_state.pendingQueue[1].size(), 1);

    g_test_state.slotBusy[1] = false;
    while (!g_test_state.pendingQueue[1].empty())
        g_test_state.pendingQueue[1].pop();
    CLOSE_CLIENT(sock);
}

// ---------------------------------- CANCEL / CANCEL_ALL (unclaimed log) ---
//
// CANCEL and CANCEL_ALL sum armedQty[i] plus everything drained from
// pendingQueue[i] into `lost`, then hand that to pump_record_unclaimed. The
// tests in test_unclaimed.cpp call pump_record_unclaimed directly, so they
// never exercise that arithmetic -- these do, over the real socket.

static const std::string UNCLAIMED_TEST_DIR = "tests/tmp_socket_unclaimed";
static const std::string UNCLAIMED_TEST_LOG = UNCLAIMED_TEST_DIR + "/unclaimed_credits.jsonl";

static std::string read_all(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

static int count_lines(const std::string &path)
{
    std::ifstream f(path);
    int n = 0;
    std::string line;
    while (std::getline(f, line))
        if (!line.empty()) n++;
    return n;
}

// Fresh log directory and a clean slate for the slots each test touches --
// mirrors fresh_state() in test_unclaimed.cpp, just against the shared
// g_test_state these integration tests already use.
static void reset_unclaimed_log()
{
    fs::remove_all(UNCLAIMED_TEST_DIR);
    fs::create_directories(UNCLAIMED_TEST_DIR);
    g_test_state.unclaimedLogPath = UNCLAIMED_TEST_LOG;
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        g_test_state.armedQty[i] = 0;
        while (!g_test_state.pendingQueue[i].empty())
            g_test_state.pendingQueue[i].pop();
    }
}

static void teardown_unclaimed_log()
{
    fs::remove_all(UNCLAIMED_TEST_DIR);
    g_test_state.unclaimedLogPath.clear();
}

void test_integration_cancel_records_unclaimed_credit()
{
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,2,3");
    CHECK(wait_for([]{ return g_test_state.armedQty[2] == 3; }));

    send_cmd(sock, "CANCEL,2");
    CHECK(wait_for([]{ return g_test_state.armedQty[2] == 0; }));

    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 1);
    std::string body = read_all(UNCLAIMED_TEST_LOG);
    CHECK(body.find("\"slot\":\"2\"") != std::string::npos);
    CHECK(body.find("\"qty\":3") != std::string::npos);
    CHECK(body.find("\"reason\":\"cancelled\"") != std::string::npos);

    CLOSE_CLIENT(sock);
}

void test_integration_cancel_sums_armed_and_queued()
{
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,3,2");
    CHECK(wait_for([]{ return g_test_state.armedQty[3] == 2; }));

    // Stand in for a second ARM that queued behind a busy slot: those
    // credits were paid for exactly like the armed ones, so a cancel must
    // write both off together.
    g_test_state.pendingQueue[3].push(PendingArm(3, 4));

    send_cmd(sock, "CANCEL,3");
    CHECK(wait_for([]{ return g_test_state.armedQty[3] == 0; }));

    CHECK_EQ((int)g_test_state.pendingQueue[3].size(), 0);
    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 1);
    CHECK(read_all(UNCLAIMED_TEST_LOG).find("\"qty\":6") != std::string::npos);

    CLOSE_CLIENT(sock);
}

void test_integration_cancel_queue_records_the_queued_credits()
{
    // CANCEL_QUEUE leaves the armed credits alone -- the cashier is still
    // mid-sale in front of the customer -- but the queued ones are money in
    // the drawer just the same, and used to be dropped with no record.
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,3,2");
    CHECK(wait_for([]{ return g_test_state.armedQty[3] == 2; }));
    g_test_state.pendingQueue[3].push(PendingArm(3, 4));

    send_cmd(sock, "CANCEL_QUEUE,3");
    CHECK(wait_for([]{ return g_test_state.pendingQueue[3].empty(); }));

    // Only the queued 4 are written off; the 2 armed presses survive.
    CHECK_EQ(g_test_state.armedQty[3], 2);
    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 1);
    CHECK(read_all(UNCLAIMED_TEST_LOG).find("\"qty\":4") != std::string::npos);
    CHECK(read_all(UNCLAIMED_TEST_LOG).find("\"reason\":\"cancelled\"") != std::string::npos);

    g_test_state.armedQty[3] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_cancel_queue_on_an_empty_queue_records_nothing()
{
    // A stray CANCEL_QUEUE with nothing queued must not write a zero row.
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "CANCEL_QUEUE,3");
    CHECK(wait_for([]{ return g_test_state.pendingQueue[3].empty(); }));

    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 0);

    CLOSE_CLIENT(sock);
}

void test_integration_cancel_all_writes_one_row_per_slot()
{
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,1,2");
    CHECK(wait_for([]{ return g_test_state.armedQty[1] == 2; }));
    send_cmd(sock, "ARM,5,3");
    CHECK(wait_for([]{ return g_test_state.armedQty[5] == 3; }));

    send_cmd(sock, "CANCEL_ALL");
    CHECK(wait_for([]{ return g_test_state.armedQty[1] == 0 && g_test_state.armedQty[5] == 0; }));

    // One row per slot, not one combined row: prices differ per product, so
    // a single total could not be reconciled back to either one.
    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 2);
    std::string body = read_all(UNCLAIMED_TEST_LOG);
    CHECK(body.find("\"slot\":\"1\"") != std::string::npos);
    CHECK(body.find("\"slot\":\"5\"") != std::string::npos);

    CLOSE_CLIENT(sock);
}

void test_integration_cancel_all_idle_writes_nothing()
{
    reset_unclaimed_log();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "CANCEL_ALL");
    yield_to_server();   // absence check: nothing here to wait_for

    CHECK_EQ(count_lines(UNCLAIMED_TEST_LOG), 0);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- WTRLVL command ---

void test_integration_wtrlvl_sets_flags()
{
    // Legacy 4-value form: slots 5..TOTAL_SLOTS must fall back to "has liquid".
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,1,0,1\n";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    wait_for([]{ return g_test_state.slotEmpty[2] && g_test_state.slotEmpty[4]; });

    CHECK(!g_test_state.slotEmpty[1]);
    CHECK( g_test_state.slotEmpty[2]);
    CHECK(!g_test_state.slotEmpty[3]);
    CHECK( g_test_state.slotEmpty[4]);
    for (int i = 5; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_six_sensors()
{
    // Full per-slot form: every slot including 5 and 6 is driven by a sensor.
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,0,0,0,1,1\n";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    wait_for([]{ return g_test_state.slotEmpty[5] && g_test_state.slotEmpty[6]; });

    for (int i = 1; i <= 4; i++) CHECK(!g_test_state.slotEmpty[i]);
    CHECK(g_test_state.slotEmpty[5]);
    CHECK(g_test_state.slotEmpty[6]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_respects_inverted_polarity()
{
    // With WATER_SENSOR_EMPTY_HIGH=0 a LOW reading is the empty one, which is
    // what sensors wired the other way round produce. Every slot's meaning
    // flips; nothing else about the parse changes.
    const int saved = WATER_SENSOR_EMPTY_HIGH;
    WATER_SENSOR_EMPTY_HIGH = 0;

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) { WATER_SENSOR_EMPTY_HIGH = saved; return; }

    std::string msg = "WTRLVL,0,1,0,1,0,1\n";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    wait_for([]{ return g_test_state.slotEmpty[1] && g_test_state.slotEmpty[5]; });

    // Inverted: the zeros are the empty slots now, not the ones.
    CHECK( g_test_state.slotEmpty[1]);
    CHECK(!g_test_state.slotEmpty[2]);
    CHECK( g_test_state.slotEmpty[3]);
    CHECK(!g_test_state.slotEmpty[4]);
    CHECK( g_test_state.slotEmpty[5]);
    CHECK(!g_test_state.slotEmpty[6]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
    WATER_SENSOR_EMPTY_HIGH = saved;
}

void test_integration_two_commands_in_one_packet()
{
    // TCP coalesces. Before newline framing the server treated a whole recv()
    // as one command, so the comma count covered BOTH lines and the pair was
    // rejected as malformed -- losing two updates at once.
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    g_test_state.armedQty[1] = 0;
    g_test_state.armedQty[2] = 0;

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string both = "ARM,1,2\nARM,2,3\n";
    send(sock, both.c_str(), (int)both.length(), 0);
    wait_for([]{ return g_test_state.armedQty[1] == 2 && g_test_state.armedQty[2] == 3; });

    CHECK_EQ((int)g_test_state.armedQty[1], 2);
    CHECK_EQ((int)g_test_state.armedQty[2], 3);

    g_test_state.armedQty[1] = 0;
    g_test_state.armedQty[2] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_command_split_across_packets()
{
    // The other half of the same problem: one command delivered in two recv()s.
    // Previously each fragment was parsed on its own and both were discarded.
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    g_test_state.armedQty[3] = 0;

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string head = "ARM,3";
    std::string tail = ",4\n";
    send(sock, head.c_str(), (int)head.length(), 0);
    yield_to_server();
    CHECK_EQ((int)g_test_state.armedQty[3], 0);   // nothing acted on yet
    send(sock, tail.c_str(), (int)tail.length(), 0);
    wait_for([]{ return g_test_state.armedQty[3] == 4; });

    CHECK_EQ((int)g_test_state.armedQty[3], 4);

    g_test_state.armedQty[3] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_status_is_newline_terminated()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "STATUS");
    CHECK(!resp.empty());
    if (!resp.empty()) CHECK_EQ(resp[resp.size() - 1], '\n');

    CLOSE_CLIENT(sock);
}

void test_integration_arm_rejects_absurd_qty()
{
    g_test_state.armedQty[1] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_and_recv(sock, "ARM,1,999999");
    CHECK_EQ((int)g_test_state.armedQty[1], 0);

    g_test_state.armedQty[1] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_all_clear()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = true;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,0,0,0\n";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_wtrlvl_is_ignored()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,1\n";   // neither 4 nor TOTAL_SLOTS values
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);
    CLOSE_CLIENT(sock);
}

// ---------------------------------- multiple clients ---

void test_integration_two_clients_independent()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock c1 = connect_test_client();
    ClientSock c2 = connect_test_client();
    CHECK(c1 != INVALID_CLIENT_SOCK);
    CHECK(c2 != INVALID_CLIENT_SOCK);
    if (c1 == INVALID_CLIENT_SOCK || c2 == INVALID_CLIENT_SOCK)
    {
        if (c1 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c1);
        if (c2 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c2);
        return;
    }
    drain_connect_push(c1);
    drain_connect_push(c2);

    // c1 sends ARM — both clients share the same AppState
    send_cmd(c1, "ARM,1,5");
    yield_to_server();
    CHECK_EQ((int)g_test_state.armedQty[1], 5);

    // c2 also gets the updated STATUS
    std::string resp = send_and_recv(c2, "STATUS");
    CHECK(resp.find("STATUS,5,") == 0);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    CLOSE_CLIENT(c1);
    CLOSE_CLIENT(c2);
}

// ---------------------------------- disconnect / reconnect ---

void test_integration_server_handles_client_disconnect()
{
    ClientSock c1 = connect_test_client();
    CHECK(c1 != INVALID_CLIENT_SOCK);
    if (c1 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c1);

    yield_to_server();

    ClientSock c2 = connect_test_client();
    CHECK(c2 != INVALID_CLIENT_SOCK);
    if (c2 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c2);
}

// ========================================================== entry point ---

// ---------------------------------- PRIME (non-revenue maintenance run) ---

// Put the machine in a known state. These run last, after earlier cases have
// armed slots and set water flags, and a prime is refused by design when the
// slot owes anyone product.
static void reset_for_prime()
{
    ClientSock sock = connect_test_client();
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);
    send_cmd(sock, "CANCEL_ALL");
    send_cmd(sock, "WTRLVL,0,0,0,0,0,0");
    yield_to_server();
    CLOSE_CLIENT(sock);
}

void test_integration_prime_acknowledges_the_caller()
{
    reset_for_prime();

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    // Without an explicit answer the dashboard cannot tell a refusal from a
    // lost packet, and staff retry blindly at the machine.
    std::string resp = send_and_recv(sock, "PRIME,5");
    CHECK(resp.find("PRIME_ACK,5,started") != std::string::npos);
    CHECK(g_test_state.slotBusy[5] == true);

    // A prime is not a sale: it must not stage credit for the slot.
    CHECK_EQ(g_test_state.armedQty[5], 0);

    CLOSE_CLIENT(sock);
}

void test_integration_prime_reports_why_it_refused()
{
    reset_for_prime();

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "PRIME,99");
    CHECK(resp.find("PRIME_ACK,99,invalid_slot") != std::string::npos);

    CLOSE_CLIENT(sock);
}

void test_integration_prime_allowed_for_an_armed_slot()
{
    reset_for_prime();

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "ARM,4,1");
    CHECK(wait_for([]{ return g_test_state.armedQty[4] > 0; }));

    // The case this exists for: a gallon is replaced while a customer still
    // holds credits on that slot, and the hose now has air in it. Refusing
    // here would send them a press of air and charge for it.
    std::string resp = send_and_recv(sock, "PRIME,4");
    CHECK(resp.find("PRIME_ACK,4,started") != std::string::npos);
    CHECK_EQ(g_test_state.armedQty[4], 1);   // their credit is not spent

    send_cmd(sock, "CANCEL_ALL");
    yield_to_server();
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_prime_is_ignored()
{
    reset_for_prime();

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send_cmd(sock, "PRIME");
    send_cmd(sock, "PRIME,notanumber");
    yield_to_server();

    // No pump may start from a command the server could not parse, and the
    // connection must survive to carry the next one.
    CHECK(g_test_state.slotBusy[6] == false);
    std::string resp = send_and_recv(sock, "Client ACK");
    CHECK(resp.find("STATUS") != std::string::npos);

    CLOSE_CLIENT(sock);
}

void run_socket_integration_tests()
{
    SUITE("socket integration (TCP protocol behavioral tests)");

    start_integration_server();

    RUN_TEST(test_integration_client_can_connect);
    RUN_TEST(test_integration_server_pushes_status_on_connect);
    RUN_TEST(test_integration_unknown_command_returns_status);
    RUN_TEST(test_integration_status_field_count);
    RUN_TEST(test_integration_arm_increases_armedQty);
    RUN_TEST(test_integration_arm_accumulates_for_same_slot);
    RUN_TEST(test_integration_arm_different_slots_independent);
    RUN_TEST(test_integration_arm_reflected_in_status);
    RUN_TEST(test_integration_malformed_arm_is_ignored);
    RUN_TEST(test_integration_arm_invalid_product_rejected);
    RUN_TEST(test_integration_arm_zero_qty_rejected);
    RUN_TEST(test_integration_arm_queues_when_slot_busy);

    RUN_TEST(test_integration_cancel_records_unclaimed_credit);
    RUN_TEST(test_integration_cancel_sums_armed_and_queued);
    RUN_TEST(test_integration_cancel_queue_records_the_queued_credits);
    RUN_TEST(test_integration_cancel_queue_on_an_empty_queue_records_nothing);
    RUN_TEST(test_integration_cancel_all_writes_one_row_per_slot);
    RUN_TEST(test_integration_cancel_all_idle_writes_nothing);
    teardown_unclaimed_log();

    RUN_TEST(test_integration_wtrlvl_sets_flags);
    RUN_TEST(test_integration_wtrlvl_six_sensors);
    RUN_TEST(test_integration_wtrlvl_respects_inverted_polarity);
    RUN_TEST(test_integration_two_commands_in_one_packet);
    RUN_TEST(test_integration_command_split_across_packets);
    RUN_TEST(test_integration_status_is_newline_terminated);
    RUN_TEST(test_integration_arm_rejects_absurd_qty);
    RUN_TEST(test_integration_wtrlvl_all_clear);
    RUN_TEST(test_integration_malformed_wtrlvl_is_ignored);
    RUN_TEST(test_integration_two_clients_independent);
    RUN_TEST(test_integration_server_handles_client_disconnect);

    // Prime last: it marks a slot busy, which earlier cases assume is clear.
    RUN_TEST(test_integration_prime_acknowledges_the_caller);
    RUN_TEST(test_integration_prime_reports_why_it_refused);
    RUN_TEST(test_integration_prime_allowed_for_an_armed_slot);
    RUN_TEST(test_integration_malformed_prime_is_ignored);

    stop_integration_server();
}
