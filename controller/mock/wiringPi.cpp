#include "wiringPi.h"
#include <iostream>
#include <thread>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <set>
#include <sstream>
#include <string>

int wiringPiSetup(void) { std::cout << "[MOCK] wiringPiSetup called" << std::endl; return 0; }
int wiringPiSetupGpio(void) { std::cout << "[MOCK] wiringPiSetupGpio called" << std::endl; return 0; }
int wiringPiSetupPhys(void) { std::cout << "[MOCK] wiringPiSetupPhys called" << std::endl; return 0; }
int wiringPiSetupSys(void) { std::cout << "[MOCK] wiringPiSetupSys called" << std::endl; return 0; }
int wiringPiSetupPinType(int pinType) { std::cout << "[MOCK] wiringPiSetupPinType(" << pinType << ") called" << std::endl; return 0; }

void pinMode(int pin, int mode) { std::cout << "[MOCK] pinMode(pin=" << pin << ", mode=" << mode << ") called" << std::endl; }
void pullUpDnControl(int pin, int pud) { std::cout << "[MOCK] pullUpDnControl(pin=" << pin << ", pud=" << pud << ") called" << std::endl; }
void digitalWrite(int pin, int value) { /* std::cout << "[MOCK] digitalWrite(pin=" << pin << ", value=" << value << ")" << std::endl; */ }
// Buttons held in-process, set by mock_set_button().
static std::set<int> g_pressed_pins;

// Buttons held by an external driver, re-read from the MOCK_BUTTONS file.
// Polled at most every 20ms: digitalRead is called for six pins on every loop
// turn, and opening a file that often would dominate the mock's runtime.
static std::set<int> g_file_pins;
static std::chrono::steady_clock::time_point g_file_checked{};

static void refresh_file_pins()
{
    const char *path = std::getenv("MOCK_BUTTONS");
    if (!path || !*path) return;

    auto now = std::chrono::steady_clock::now();
    if (g_file_checked.time_since_epoch().count() != 0 &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - g_file_checked).count() < 20)
        return;
    g_file_checked = now;

    g_file_pins.clear();
    std::ifstream f(path);
    if (!f.is_open()) return;      // absent file means nothing is pressed

    std::string tok;
    while (f >> tok) {
        for (char &c : tok) if (c == ',') c = ' ';
        std::istringstream ts(tok);
        int pin;
        while (ts >> pin) g_file_pins.insert(pin);
    }
}

void mock_set_button(int pin, bool pressed)
{
    if (pressed) g_pressed_pins.insert(pin);
    else         g_pressed_pins.erase(pin);
}

void mock_release_all_buttons(void)
{
    g_pressed_pins.clear();
}

int digitalRead(int pin)
{
    refresh_file_pins();
    // Active low: pressed pulls the pin to ground.
    if (g_pressed_pins.count(pin) || g_file_pins.count(pin)) return LOW;
    return HIGH;
}

void delay(unsigned int howLong) { std::this_thread::sleep_for(std::chrono::milliseconds(howLong)); }
void delayMicroseconds(unsigned int howLong) { std::this_thread::sleep_for(std::chrono::microseconds(howLong)); }

int wiringPiISR(int pin, int mode, void (*function)(void)) {
    std::cout << "[MOCK] wiringPiISR(pin=" << pin << ", mode=" << mode << ") registered" << std::endl;
    return 0;
}

// wiringPiI2C Mocks
#include "wiringPiI2C.h"
int wiringPiI2CSetup(int devId) { std::cout << "[MOCK] wiringPiI2CSetup(devId=" << devId << ")" << std::endl; return 100; }
int wiringPiI2CRead(int fd) { return 0; }
int wiringPiI2CReadReg8(int fd, int reg) { return 0; }
int wiringPiI2CReadReg16(int fd, int reg) { return 0; }
int wiringPiI2CWrite(int fd, int data) { return 0; }
int wiringPiI2CWriteReg8(int fd, int reg, int data) { return 0; }
int wiringPiI2CWriteReg16(int fd, int reg, int data) { return 0; }
