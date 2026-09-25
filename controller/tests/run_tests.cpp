// Phase 3 eliminated all extern globals — modules receive state through
// AppState& parameters, so no stub definitions are needed here.

#include "test_framework.h"
#include <iostream>

// Phase 1 suites
void run_utils_tests();
void run_socket_cmd_tests();
void run_mock_tests();
void run_hardware_tests();

// Phase 2-10 suites
void run_transaction_json_tests();
void run_app_state_tests();
void run_product_config_tests();
void run_transaction_write_tests();
void run_module_linkage_tests();
void run_input_validation_tests();
void run_config_loading_tests();
void run_armed_state_tests();
void run_logging_tests();

// Prime / purge -- non-revenue maintenance dispense
void run_prime_tests();

// Per-client prices, audited on every change
void run_price_tests();

// A tank running dry mid-dispense
void run_dry_tank_tests();

// Several presses on one pour -- one sale per press, not one per pour
void run_multi_press_tests();

// A press on an idle pump must be held before it starts a pour
void run_button_hold_tests();

// Armed credits that time out unclaimed
void run_unclaimed_tests();

// Socket protocol integration tests (Phase 9/10)
void run_socket_integration_tests();

int main()
{
    std::cout << "Coin Slot Unit Tests\n";
    std::cout << "====================\n";

    run_utils_tests();
    run_socket_cmd_tests();
    run_mock_tests();
    run_hardware_tests();

    run_transaction_json_tests();
    run_app_state_tests();
    run_product_config_tests();
    run_transaction_write_tests();
    run_module_linkage_tests();
    run_input_validation_tests();
    run_config_loading_tests();
    run_armed_state_tests();
    run_logging_tests();
    run_prime_tests();
    run_price_tests();
    run_dry_tank_tests();
    run_multi_press_tests();
    run_button_hold_tests();
    run_unclaimed_tests();

    // Integration tests run last — they bind a real socket on port 9901
    run_socket_integration_tests();

    std::cout << "\n====================\n";
    std::cout << "Results: "
              << g_passes   << " passed, "
              << g_failures << " failed\n";

    return (g_failures > 0) ? 1 : 0;
}
