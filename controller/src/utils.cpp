#include "utils.h"
#include "app_state.h"
#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <limits.h>
#endif

std::string trim(const std::string &s)
{
  size_t start = s.find_first_not_of(" \t\n\r\f\v");
  size_t end   = s.find_last_not_of(" \t\n\r\f\v");
  if (std::string::npos == start) return "";
  return s.substr(start, end - start + 1);
}

std::map<std::string, std::string> loadEnv(const std::string &filepath)
{
  std::map<std::string, std::string> env_vars;
  std::ifstream file(filepath);

  if (!file.is_open())
  {
    log_error("utils", "Could not open env file at " + filepath + ". Continuing without it.");
    return env_vars;
  }

  std::string line;
  while (std::getline(file, line))
  {
    line = trim(line);
    if (line.empty() || line[0] == '#') continue;

    size_t equals_pos = line.find('=');
    if (equals_pos == std::string::npos)
    {
      log_error("utils", "Skipping malformed line in env file: " + line);
      continue;
    }

    std::string key   = trim(line.substr(0, equals_pos));
    std::string value = trim(line.substr(equals_pos + 1));

    if (value.length() >= 2 && value.front() == '"' && value.back() == '"')
      value = value.substr(1, value.length() - 2);
    else if (value.length() >= 2 && value.front() == '\'' && value.back() == '\'')
      value = value.substr(1, value.length() - 2);

    if (!key.empty()) env_vars[key] = value;
  }

  file.close();
  log_info("utils", "Env file loaded from: " + filepath);
  return env_vars;
}

std::string format_current_time(std::chrono::system_clock::time_point time_point)
{
  std::time_t now_c    = std::chrono::system_clock::to_time_t(time_point);
  std::tm *local_tm    = std::localtime(&now_c);
  std::stringstream ss;
  ss << std::put_time(local_tm, "%Y-%m-%d %H:%M:%S");
  return ss.str();
}

bool appendJsonLine(const std::string &path, const std::string &json)
{
  if (path.empty()) return false;

  std::string parent = fs::path(path).parent_path().string();
  if (!parent.empty() && !ensureDirectoryExists(parent)) return false;

  std::ofstream f(path, std::ios::app);
  if (!f.is_open())
  {
    log_error("utils", "Could not append to " + path);
    return false;
  }
  f << json << "\n";
  return f.good();
}

bool ensureDirectoryExists(const std::string &path)
{
  fs::path dirPath = path;
  if (fs::exists(dirPath)) return true;  // already there — ready to use
  try
  {
    if (fs::create_directories(dirPath))
    {
      log_info("utils", "Directory created: " + path);
      return true;
    }
    // create_directories returned false without throwing — path exists but isn't a directory
    log_error("utils", "Path exists but is not a directory: " + path);
  }
  catch (const std::exception &e)
  {
    log_error("utils", std::string("Error creating directory '") + path + "': " + e.what());
  }
  return false;
}

std::string get_binary_dir()
{
#ifdef _WIN32
  char path[MAX_PATH];
  GetModuleFileNameA(NULL, path, MAX_PATH);
  return fs::path(path).parent_path().string();
#else
  char path[PATH_MAX];
  ssize_t count = readlink("/proc/self/exe", path, PATH_MAX - 1);
  if (count > 0) {
    path[count] = '\0';
    return fs::path(path).parent_path().string();
  }
  return ".";
#endif
}

void log_info(const std::string &module, const std::string &msg)
{
  std::cout << "[" << format_current_time() << "] [" << module << "] " << msg << std::endl;
}

void log_error(const std::string &module, const std::string &msg)
{
  std::cerr << "[" << format_current_time() << "] [" << module << "] ERROR: " << msg << std::endl;
}

// ---------------------------------------------------------------------------
// Crash persistence — survive Pi restarts without losing in-progress sales
// ---------------------------------------------------------------------------

bool saveStateToDisk(const AppState &state, const std::string &dir)
{
  std::string filepath = dir + "/state.dat";
  std::ofstream file(filepath, std::ios::trunc);
  if (!file.is_open()) {
    log_error("utils", "Could not open state file for writing: " + filepath);
    return false;
  }
  // Write armedQty[1..TOTAL_SLOTS] one per line
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    file << "ARMED_" << i << "=" << state.armedQty[i] << "\n";
  }
  // Write pending queue sizes
  for (int i = 1; i <= TOTAL_SLOTS; i++) {
    // We can't easily iterate a std::queue, so just save the size.
    // Full queue reconstruction is handled by the dashboard re-sending on reconnect.
    file << "QUEUE_" << i << "=" << (int)state.pendingQueue[i].size() << "\n";
  }
  file.close();
  return true;
}

bool loadStateFromDisk(AppState &state, const std::string &dir)
{
  std::string filepath = dir + "/state.dat";
  std::ifstream file(filepath);
  if (!file.is_open()) return false;  // no saved state — fresh start

  std::string line;
  while (std::getline(file, line)) {
    line = trim(line);
    if (line.empty()) continue;
    size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    std::string key = line.substr(0, eq);
    int val = std::stoi(line.substr(eq + 1));

    if (key.rfind("ARMED_", 0) == 0) {
      int slot = std::stoi(key.substr(6));
      if (slot >= 1 && slot <= TOTAL_SLOTS) state.armedQty[slot] = val;
    }
    // QUEUE entries are logged but can't be fully restored without
    // the original ARM command data; the dashboard will re-send on reconnect.
    if (key.rfind("QUEUE_", 0) == 0) {
      log_info("utils", "State restored: slot " + key.substr(6) + " had " + std::to_string(val) + " queued ARM(s)");
    }
  }
  file.close();
  log_info("utils", "State loaded from " + filepath);
  return true;
}
