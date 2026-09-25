#include <thread>

#ifndef _WIN32
#include <signal.h>
#endif

#include "includes/app_state.h"
#include "includes/pump_control.h"
#include "includes/socket_server.h"
#include "includes/utils.h"

AppState g_state;

#ifndef _WIN32
static volatile sig_atomic_t g_running = 1;
static void handle_signal(int) { g_running = 0; }
#endif

int main()
{
#ifndef _WIN32
    signal(SIGTERM, handle_signal);
    signal(SIGINT,  handle_signal);
    signal(SIGPIPE, SIG_IGN);   // prevent broken-pipe from killing the process
#endif

    pump_setup(g_state);
    server_app_setup(g_state);

#ifndef _WIN32
    while (g_running)
#else
    while (true)
#endif
    {
        pump_loop(g_state);
        server_app_loop(g_state);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    pump_shutdown();
    cleanup_socket_environment();
    log_info("main", "Shutdown complete.");
    return 0;
}
