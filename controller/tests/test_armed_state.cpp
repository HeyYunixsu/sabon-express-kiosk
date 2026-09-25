#include "test_framework.h"
#include "app_state.h"
#include <queue>

// Phase 9 — Per-slot armed state and pending queues (was: voucherQueue/maxCoinCredit)
//
// Changes tested here:
//   1. AppState.armedQty[1..TOTAL_SLOTS] starts at 0 for every slot
//   2. AppState.pendingQueue[1..4] starts empty for every slot
//   3. AppState.slotBusy[1..4] defaults to false
//   4. PendingArm struct construction and field access
//   5. Multiple AppState instances have independent armed state
//   6. Per-slot pending queues are independent of each other

// ---------------------------------- armedQty in AppState ---

void test_appstate_armedQty_defaults_zero()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(s.armedQty[i], 0);
}

void test_appstate_armedQty_can_be_set()
{
    AppState s;
    s.armedQty[1] = 3;
    CHECK_EQ(s.armedQty[1], 3);
    CHECK_EQ(s.armedQty[2], 0);  // other slots unaffected
}

void test_appstate_armedQty_decrement()
{
    AppState s;
    s.armedQty[1] = 5;
    s.armedQty[1]--;
    CHECK_EQ(s.armedQty[1], 4);
}

// ---------------------------------- pendingQueue in AppState ---

void test_appstate_pendingQueue_starts_empty()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(s.pendingQueue[i].empty());
}

void test_appstate_pendingQueue_push_increases_size()
{
    AppState s;
    s.pendingQueue[1].push(PendingArm(1, 10));
    CHECK_EQ((int)s.pendingQueue[1].size(), 1);
}

void test_appstate_pendingQueue_fifo_order()
{
    AppState s;
    s.pendingQueue[1].push(PendingArm(1, 5));
    s.pendingQueue[1].push(PendingArm(1, 10));
    PendingArm first = s.pendingQueue[1].front();
    CHECK_EQ(first.qty, 5);
    s.pendingQueue[1].pop();
    PendingArm second = s.pendingQueue[1].front();
    CHECK_EQ(second.qty, 10);
}

void test_appstate_pendingQueue_empty_after_draining()
{
    AppState s;
    s.pendingQueue[1].push(PendingArm(1, 5));
    s.pendingQueue[1].pop();
    CHECK(s.pendingQueue[1].empty());
}

// ---------------------------------- PendingArm struct ---

void test_pendingArm_default_construction()
{
    PendingArm p;
    CHECK_EQ(p.productId, 0);
    CHECK_EQ(p.qty, 0);
}

void test_pendingArm_value_construction()
{
    PendingArm p(3, 7);
    CHECK_EQ(p.productId, 3);
    CHECK_EQ(p.qty, 7);
}

// ---------------------------------- slotBusy in AppState ---

void test_appstate_slotBusy_defaults_false()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(!s.slotBusy[i]);
}

void test_appstate_slotBusy_can_be_set()
{
    AppState s;
    s.slotBusy[1] = true;
    CHECK(s.slotBusy[1]);
    CHECK(!s.slotBusy[2]);  // other slots unaffected
}

// ---------------------------------- Independence between instances ---

void test_two_appstate_armedQty_independent()
{
    AppState s1, s2;
    s1.armedQty[1] = 99;
    CHECK_EQ(s1.armedQty[1], 99);
    CHECK_EQ(s2.armedQty[1], 0);  // s2 must not be affected
}

void test_per_slot_queues_independent()
{
    AppState s;
    s.pendingQueue[1].push(PendingArm(1, 3));
    s.pendingQueue[2].push(PendingArm(2, 5));
    CHECK_EQ((int)s.pendingQueue[1].size(), 1);
    CHECK_EQ((int)s.pendingQueue[2].size(), 1);
    // Pop from slot 1 — slot 2 unaffected
    s.pendingQueue[1].pop();
    CHECK(s.pendingQueue[1].empty());
    CHECK_EQ((int)s.pendingQueue[2].size(), 1);
}

// ---------------------------------------------------------- entry point ---

void run_armed_state_tests()
{
    SUITE("armed_state (per-slot armed state + pending queues)");
    RUN_TEST(test_appstate_armedQty_defaults_zero);
    RUN_TEST(test_appstate_armedQty_can_be_set);
    RUN_TEST(test_appstate_armedQty_decrement);
    RUN_TEST(test_appstate_pendingQueue_starts_empty);
    RUN_TEST(test_appstate_pendingQueue_push_increases_size);
    RUN_TEST(test_appstate_pendingQueue_fifo_order);
    RUN_TEST(test_appstate_pendingQueue_empty_after_draining);
    RUN_TEST(test_pendingArm_default_construction);
    RUN_TEST(test_pendingArm_value_construction);
    RUN_TEST(test_appstate_slotBusy_defaults_false);
    RUN_TEST(test_appstate_slotBusy_can_be_set);
    RUN_TEST(test_two_appstate_armedQty_independent);
    RUN_TEST(test_per_slot_queues_independent);
}
