#include "test_framework.h"
#include "app_state.h"
#include <string>

// Phase 3 — AppState struct (updated for per-slot armed state)
//
// Tests pin down the struct's initial defaults and verify every field
// can be read and written independently.

// ------------------------------------------- default values ---

void test_appstate_armedQty_default_zero()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(s.armedQty[i], 0);
}

void test_appstate_machineId_default_is_1()
{
    AppState s;
    CHECK_EQ(s.machineId, std::string("1"));
}

void test_appstate_vendorId_default_empty()
{
    AppState s;
    CHECK_EQ(s.vendorId, std::string(""));
}

void test_appstate_remainingTime_all_zero()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(s.remainingTime[i], 0LL);
}

void test_appstate_slotEmpty_all_false()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(!s.slotEmpty[i]);
}

void test_appstate_paused_default_false()
{
    AppState s;
    CHECK(!s.paused);
}

void test_appstate_slotBusy_default_false()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(!s.slotBusy[i]);
}

void test_appstate_pendingQueue_default_empty()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(s.pendingQueue[i].empty());
}

// -------------------------------------- independent mutation ---

void test_appstate_armedQty_add_subtract()
{
    AppState s;
    s.armedQty[1] += 10;
    CHECK_EQ(s.armedQty[1], 10);
    s.armedQty[1] -= 5;
    CHECK_EQ(s.armedQty[1], 5);
}

void test_appstate_machineId_and_vendorId_set()
{
    AppState s;
    s.machineId = "machine_99";
    s.vendorId  = "vendor_ABC";
    CHECK_EQ(s.machineId, std::string("machine_99"));
    CHECK_EQ(s.vendorId,  std::string("vendor_ABC"));
}

void test_appstate_remainingTime_per_pump_independent()
{
    AppState s;
    s.remainingTime[1] = 5000;
    s.remainingTime[4] = 3000;
    CHECK_EQ(s.remainingTime[1], 5000LL);
    CHECK_EQ(s.remainingTime[2], 0LL);
    CHECK_EQ(s.remainingTime[3], 0LL);
    CHECK_EQ(s.remainingTime[4], 3000LL);
}

void test_appstate_slotEmpty_per_pump_independent()
{
    AppState s;
    s.slotEmpty[2] = true;
    s.slotEmpty[3] = true;
    CHECK(!s.slotEmpty[1]);
    CHECK( s.slotEmpty[2]);
    CHECK( s.slotEmpty[3]);
    CHECK(!s.slotEmpty[4]);
}

void test_appstate_paused_toggle()
{
    AppState s;
    s.paused = true;
    CHECK(s.paused);
    s.paused = false;
    CHECK(!s.paused);
}

// ------------------- two AppState instances are independent ---

void test_appstate_two_instances_do_not_share_state()
{
    AppState a, b;
    a.armedQty[1] = 50;
    b.armedQty[1] = 0;
    CHECK_EQ(a.armedQty[1], 50);
    CHECK_EQ(b.armedQty[1], 0);

    b.paused = true;
    CHECK(!a.paused);
}

// ---------------------------------------------------------- entry point ---

void run_app_state_tests()
{
    SUITE("app_state (AppState)");
    RUN_TEST(test_appstate_armedQty_default_zero);
    RUN_TEST(test_appstate_machineId_default_is_1);
    RUN_TEST(test_appstate_vendorId_default_empty);
    RUN_TEST(test_appstate_remainingTime_all_zero);
    RUN_TEST(test_appstate_slotEmpty_all_false);
    RUN_TEST(test_appstate_paused_default_false);
    RUN_TEST(test_appstate_slotBusy_default_false);
    RUN_TEST(test_appstate_pendingQueue_default_empty);
    RUN_TEST(test_appstate_armedQty_add_subtract);
    RUN_TEST(test_appstate_machineId_and_vendorId_set);
    RUN_TEST(test_appstate_remainingTime_per_pump_independent);
    RUN_TEST(test_appstate_slotEmpty_per_pump_independent);
    RUN_TEST(test_appstate_paused_toggle);
    RUN_TEST(test_appstate_two_instances_do_not_share_state);
}
