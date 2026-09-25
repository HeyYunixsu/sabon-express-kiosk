#include "transaction.h"
#include "app_state.h"
#include "utils.h"
#include <fstream>
#include <chrono>
#include <iostream>

bool writeTransactionJson(const Transaction &obj, const std::string &filePath)
{
  std::ofstream file(filePath);
  if (!file.is_open())
  {
    log_error("transaction", "Could not open file for writing: " + filePath);
    return false;
  }

  file << "{\n";
  file << "  \"machine_id\": \"" << obj.machineId << "\",\n";
  file << "  \"vendor_id\": \"" << obj.vendorId << "\",\n";
  file << "  \"voucher_id\": \"" << obj.voucherId << "\",\n";
  file << "  \"amount\": " << obj.amount << ",\n";
  file << "  \"slot\": \"" << obj.slot << "\",\n";
  file << "  \"date_created\": \"" << obj.dateCreated << "\"\n";
  file << "}";

  file.close();
  return true;
}

void writeTransaction(AppState &state, int slot, double amount, std::string voucherId, int postfix)
{
  auto now = std::chrono::system_clock::now();
  Transaction t1;
  t1.machineId = state.machineId;
  t1.vendorId = state.vendorId;
  t1.slot = std::to_string(slot);
  t1.amount = amount;
  t1.dateCreated = format_current_time(now);

  if (voucherId.length() > 0)
    t1.voucherId = voucherId;

  ensureDirectoryExists(state.transactionDir);

  auto now_seconds = std::chrono::time_point_cast<std::chrono::seconds>(now);
  long long unixTimestamp = now_seconds.time_since_epoch().count();
  std::string filename = state.transactionDir + "/" + std::to_string(unixTimestamp)
                         + "_transaction_" + t1.slot + "_" + std::to_string(postfix) + ".json";

  writeTransactionJson(t1, filename);
}
