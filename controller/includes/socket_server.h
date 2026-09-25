#ifndef SOCKET_SERVER_H
#define SOCKET_SERVER_H

#include <vector>
#include <string>
#include "app_state.h"

#ifdef _WIN32
#include <winsock2.h>
typedef SOCKET SocketHandle;
#else
#include <netinet/in.h>
typedef int SocketHandle;
#endif

// --- Constants ---
extern const int MAX_BUFFER_SIZE;

// Upper bound on a single ARM/ARM_BATCH quantity. Guards against a mistyped
// cashier entry arming thousands of units, and against armedQty overflowing
// across repeated adds.
extern const int MAX_ARM_QTY;

// --- Server Functions ---
bool initialize_socket_environment();
bool create_and_bind_server_socket(int port);
bool start_listening_for_connections();
void accept_new_client_connections();
void manage_connected_clients(AppState &state);
void cleanup_socket_environment();

void server_app_setup(AppState &state);
void server_app_loop(AppState &state);

// --- Helpers ---
bool isFirstWordTest(const char *str, const char *target_word);
void set_socket_non_blocking(SocketHandle sock);
int  socket_count_commas(const char *s);  // exposed for testing

#endif // SOCKET_SERVER_H
