#include "test_framework.h"
#include <wiringPi.h>
#include <wiringPiI2C.h>

// These tests verify that the wiringPi mock (mock/wiringPi.cpp) provides the
// correct stub behaviour so the application logic compiles and runs on Windows
// without real Raspberry Pi hardware.

// ------------------------------------------------------ Setup functions ---

void test_wiringPiSetup_returns_zero() {
    CHECK_EQ(wiringPiSetup(), 0);
}

void test_wiringPiSetupGpio_returns_zero() {
    CHECK_EQ(wiringPiSetupGpio(), 0);
}

void test_wiringPiSetupPhys_returns_zero() {
    CHECK_EQ(wiringPiSetupPhys(), 0);
}

void test_wiringPiSetupSys_returns_zero() {
    CHECK_EQ(wiringPiSetupSys(), 0);
}

// ------------------------------------------------------- GPIO functions ---

void test_digitalRead_idles_high() {
    // Buttons are wired GPIO -> GND, so LOW means pressed. The mock used to
    // return LOW unconditionally while its comment claimed that was "idle" --
    // exactly backwards. Every button read as held forever, the edge detector
    // fired once at startup and never again, and no press could be simulated.
    mock_release_all_buttons();
    CHECK_EQ(digitalRead(0),  HIGH);
    CHECK_EQ(digitalRead(14), HIGH);
    CHECK_EQ(digitalRead(27), HIGH);
}

void test_a_pressed_button_reads_low() {
    mock_release_all_buttons();
    mock_set_button(14, true);

    CHECK_EQ(digitalRead(14), LOW);
    CHECK_EQ(digitalRead(15), HIGH);   // its neighbour is unaffected

    mock_set_button(14, false);
    CHECK_EQ(digitalRead(14), HIGH);
}

void test_release_all_clears_every_button() {
    mock_set_button(14, true);
    mock_set_button(15, true);
    mock_release_all_buttons();

    CHECK_EQ(digitalRead(14), HIGH);
    CHECK_EQ(digitalRead(15), HIGH);
}

void test_pinMode_does_not_crash() {
    pinMode(14, INPUT);
    pinMode(15, OUTPUT);
    CHECK(true); // reaching here means no crash
}

void test_digitalWrite_does_not_crash() {
    digitalWrite(15, HIGH);
    digitalWrite(15, LOW);
    CHECK(true);
}

void test_pullUpDnControl_does_not_crash() {
    pullUpDnControl(27, PUD_DOWN);
    pullUpDnControl(27, PUD_UP);
    CHECK(true);
}

void test_wiringPiISR_returns_zero() {
    // ISR registration must succeed (return 0) so setup() does not abort
    CHECK_EQ(wiringPiISR(14, INT_EDGE_RISING,  nullptr), 0);
    CHECK_EQ(wiringPiISR(24, INT_EDGE_RISING,  nullptr), 0);
    CHECK_EQ(wiringPiISR(27, INT_EDGE_FALLING, nullptr), 0);
}

// ------------------------------------------------------ Timing functions ---

void test_delay_does_not_crash() {
    delay(1); // 1 ms — short enough for a test
    CHECK(true);
}

void test_delayMicroseconds_does_not_crash() {
    delayMicroseconds(100);
    CHECK(true);
}

// --------------------------------------------------------- I2C functions ---

void test_wiringPiI2CSetup_returns_stub_handle() {
    // Mock always returns fd=100 regardless of device address
    CHECK_EQ(wiringPiI2CSetup(0x27), 100);
    CHECK_EQ(wiringPiI2CSetup(0x3F), 100);
}

void test_wiringPiI2CRead_returns_zero() {
    CHECK_EQ(wiringPiI2CRead(100), 0);
}

void test_wiringPiI2CWrite_returns_zero() {
    CHECK_EQ(wiringPiI2CWrite(100, 0xFF), 0);
}

void test_wiringPiI2CReadReg8_returns_zero() {
    CHECK_EQ(wiringPiI2CReadReg8(100, 0x00), 0);
}

void test_wiringPiI2CReadReg16_returns_zero() {
    CHECK_EQ(wiringPiI2CReadReg16(100, 0x00), 0);
}

void test_wiringPiI2CWriteReg8_returns_zero() {
    CHECK_EQ(wiringPiI2CWriteReg8(100, 0x00, 0xFF), 0);
}

void test_wiringPiI2CWriteReg16_returns_zero() {
    CHECK_EQ(wiringPiI2CWriteReg16(100, 0x00, 0xABCD), 0);
}

// ---------------------------------------------------------- entry point ---

void run_mock_tests() {
    SUITE("wiringPi mock");
    RUN_TEST(test_wiringPiSetup_returns_zero);
    RUN_TEST(test_wiringPiSetupGpio_returns_zero);
    RUN_TEST(test_wiringPiSetupPhys_returns_zero);
    RUN_TEST(test_wiringPiSetupSys_returns_zero);
    RUN_TEST(test_digitalRead_idles_high);
    RUN_TEST(test_a_pressed_button_reads_low);
    RUN_TEST(test_release_all_clears_every_button);
    RUN_TEST(test_pinMode_does_not_crash);
    RUN_TEST(test_digitalWrite_does_not_crash);
    RUN_TEST(test_pullUpDnControl_does_not_crash);
    RUN_TEST(test_wiringPiISR_returns_zero);
    RUN_TEST(test_delay_does_not_crash);
    RUN_TEST(test_delayMicroseconds_does_not_crash);
    RUN_TEST(test_wiringPiI2CSetup_returns_stub_handle);
    RUN_TEST(test_wiringPiI2CRead_returns_zero);
    RUN_TEST(test_wiringPiI2CWrite_returns_zero);
    RUN_TEST(test_wiringPiI2CReadReg8_returns_zero);
    RUN_TEST(test_wiringPiI2CReadReg16_returns_zero);
    RUN_TEST(test_wiringPiI2CWriteReg8_returns_zero);
    RUN_TEST(test_wiringPiI2CWriteReg16_returns_zero);
}
