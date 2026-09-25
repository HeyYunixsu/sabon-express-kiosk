#include "test_framework.h"
#include "hardware_config.h"

// Phase 4 collapsed 4 copy-pasted pump blocks into a single handlePump()
// loop driven by PumpState and productMap.  handlePump() lives in main.cpp
// and cannot be unit-tested in isolation, but the product configuration that
// drives every pump-timing decision CAN be tested: if these values are wrong,
// pumps run for the wrong duration regardless of how clean the loop is.
//
// Phase 8 renamed Product.second -> Product.durationSeconds.
// (productMap was relocated to hardware_config.cpp in Phase 5.)

// ------------------------------------------- map completeness ---

void test_productMap_has_an_entry_per_slot()
{
    CHECK_EQ((int)productMap.size(), TOTAL_SLOTS);
}

// -------------------------------------------------- id fields ---

void test_product1_id_is_1() { CHECK_EQ(productMap[1].id, 1); }
void test_product2_id_is_2() { CHECK_EQ(productMap[2].id, 2); }
void test_product3_id_is_3() { CHECK_EQ(productMap[3].id, 3); }
void test_product4_id_is_4() { CHECK_EQ(productMap[4].id, 4); }

// ------------------------------------------- coin cost fields ---

void test_all_products_cost_5_coins()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(productMap[i].coins, 5);
}

// ------------------------------------------- durationSeconds ---
// These constants control how long each pump runs per 5-coin insert.

void test_product1_durationSeconds()
{
    double expected = 2.777777777777778;
    double actual   = productMap[1].durationSeconds;
    CHECK(actual > expected - 0.0001 && actual < expected + 0.0001);
}

void test_product2_durationSeconds()
{
    double expected = 1.363636363636364;
    double actual   = productMap[2].durationSeconds;
    CHECK(actual > expected - 0.0001 && actual < expected + 0.0001);
}

void test_product3_durationSeconds()
{
    double expected = 1.25;
    double actual   = productMap[3].durationSeconds;
    CHECK(actual > expected - 0.0001 && actual < expected + 0.0001);
}

void test_product4_durationSeconds()
{
    double expected = 2.0;
    double actual   = productMap[4].durationSeconds;
    CHECK(actual > expected - 0.0001 && actual < expected + 0.0001);
}

// ---------------------- derived: milliseconds added per insert ---

void test_product1_ms_extension_is_2777()
{
    int ms = (int)(productMap[1].durationSeconds * 1000);
    CHECK_EQ(ms, 2777);
}

void test_product2_ms_extension_is_1363()
{
    int ms = (int)(productMap[2].durationSeconds * 1000);
    CHECK_EQ(ms, 1363);
}

void test_product3_ms_extension_is_1250()
{
    int ms = (int)(productMap[3].durationSeconds * 1000);
    CHECK_EQ(ms, 1250);
}

void test_product4_ms_extension_is_2000()
{
    int ms = (int)(productMap[4].durationSeconds * 1000);
    CHECK_EQ(ms, 2000);
}

// -------------------------------- product ids match map keys ---

void test_product_id_matches_map_key()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(productMap[i].id, i);
}

// ---------------------------------------------------------- entry point ---

void run_product_config_tests()
{
    SUITE("product_config (product config drives pump timing)");
    RUN_TEST(test_productMap_has_an_entry_per_slot);
    RUN_TEST(test_product1_id_is_1);
    RUN_TEST(test_product2_id_is_2);
    RUN_TEST(test_product3_id_is_3);
    RUN_TEST(test_product4_id_is_4);
    RUN_TEST(test_all_products_cost_5_coins);
    RUN_TEST(test_product1_durationSeconds);
    RUN_TEST(test_product2_durationSeconds);
    RUN_TEST(test_product3_durationSeconds);
    RUN_TEST(test_product4_durationSeconds);
    RUN_TEST(test_product1_ms_extension_is_2777);
    RUN_TEST(test_product2_ms_extension_is_1363);
    RUN_TEST(test_product3_ms_extension_is_1250);
    RUN_TEST(test_product4_ms_extension_is_2000);
    RUN_TEST(test_product_id_matches_map_key);
}
