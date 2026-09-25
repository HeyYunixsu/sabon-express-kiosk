#ifndef UTILS_H
#define UTILS_H

#include <string>
#include <map>
#include <chrono>
#include <filesystem>

namespace fs = std::filesystem;

std::string trim(const std::string &s);

std::map<std::string, std::string> loadEnv(const std::string &filepath = ".env");

std::string format_current_time(
    std::chrono::system_clock::time_point time_point = std::chrono::system_clock::now());

// Returns true if the directory is ready to use (already existed OR just created).
// Returns false only if the directory could not be created.
bool ensureDirectoryExists(const std::string &path);

// Crash persistence: save/load armedQty + pendingQueue to disk so in-progress
// sales survive a Pi restart. Called on every state change.
struct AppState;  // forward declaration
bool saveStateToDisk(const AppState &state, const std::string &dir);
bool loadStateFromDisk(AppState &state, const std::string &dir);

// Returns the absolute directory that contains the running binary.
// Used to build config/transaction paths that are independent of CWD.
std::string get_binary_dir();

// Append one line of JSON to a file, creating the parent directory if needed.
// Used for the append-only records that must survive the uploader: prime
// events and price changes. Returns false if the line could not be written.
bool appendJsonLine(const std::string &path, const std::string &json);

// Structured logging — writes "[YYYY-MM-DD HH:MM:SS] [module] msg" to stdout/stderr.
void log_info(const std::string &module, const std::string &msg);
void log_error(const std::string &module, const std::string &msg);

#endif // UTILS_H
