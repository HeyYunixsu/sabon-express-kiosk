#ifndef MOCK_WIRINGPI_H
#define MOCK_WIRINGPI_H

#include <stdint.h>

#ifdef _WIN32
// windows.h declares `typedef struct tagINPUT { ... } INPUT, *LPINPUT;` and
// socket_server.h pulls in <winsock2.h> AFTER this header. Defining INPUT as a
// macro first corrupts that declaration, so the Windows/mock build failed to
// compile at all. Let Windows declare its own types before the macros below;
// nothing in this project uses INPUT as a Windows type afterwards.
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#endif

// Constants
#define INPUT 0
#define OUTPUT 1
#define PWM_OUTPUT 2
#define GPIO_CLOCK 3
#define SOFT_PWM_OUTPUT 4
#define SOFT_TONE_OUTPUT 5
#define PWM_MS_OUTPUT 6
#define MOCK_OUTPUT 7

#define LOW 0
#define HIGH 1

#define PUD_OFF 0
#define PUD_DOWN 1
#define PUD_UP 2

#define INT_EDGE_SETUP 0
#define INT_EDGE_FALLING 1
#define INT_EDGE_RISING 2
#define INT_EDGE_BOTH 3

#define WPI_PIN_BCM 1

enum WPIPinType {
    WPI_MODE_PINS = 0,
    WPI_MODE_GPIO = 1,
    WPI_MODE_GPIO_SYS = 2,
    WPI_MODE_PHYS = 3,
    WPI_MODE_PIFACE = 4,
    WPI_MODE_UNINITIALISED = -1
};

// Functions
#ifdef __cplusplus
extern "C" {
#endif

int wiringPiSetup(void);
int wiringPiSetupGpio(void);
int wiringPiSetupPhys(void);
int wiringPiSetupSys(void);
int wiringPiSetupPinType(int pinType);

void pinMode(int pin, int mode);
void pullUpDnControl(int pin, int pud);
void digitalWrite(int pin, int value);
int digitalRead(int pin);

// ---------------------------------------------------------------------------
// Mock button control
//
// digitalRead used to return LOW unconditionally, which means "pressed" for
// these active-low buttons. Every button therefore read as held down forever:
// the edge detector fired once at startup and never again, so no press could
// ever be simulated and the mock could not exercise a dispense at all.
//
// Idle is HIGH now, and a press is asked for explicitly.
// ---------------------------------------------------------------------------

// In-process control, for tests linked against the mock.
void mock_set_button(int pin, bool pressed);
void mock_release_all_buttons(void);

// Out-of-process control, for driving a running mock binary. Set the
// environment variable MOCK_BUTTONS to a file path; write the BCM pin numbers
// that are currently held to that file, space or comma separated. An empty or
// missing file means nothing is pressed.


void delay(unsigned int howLong);
void delayMicroseconds(unsigned int howLong);

int wiringPiISR(int pin, int mode, void (*function)(void));

#ifdef __cplusplus
}
#endif

#endif // MOCK_WIRINGPI_H
