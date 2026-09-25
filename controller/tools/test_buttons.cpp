// test_buttons.cpp — standalone button tester for Sabon Express controller
//
// Reads all 6 buttons (BCM GPIO, active-low: button wired GPIO -> GND).
// The pull-up is set at boot via /boot/firmware/config.txt (gpio=X=ip,pu) —
// this program does NOT configure the pull (wiringPi's pull-up is unreliable
// on Debian), so it tests exactly what the firmware sees.
//
// Build:  g++ -o test_buttons test_buttons.cpp -lwiringPi
// Run:    sudo ./test_buttons
//
// Expected HEALTHY output (after config.txt pull-up + reboot):
//   - All buttons show "OPEN (1)" when NOT touched.
//   - Each press shows ">>> PRESSED" and release "<<< RELEASED".
//
// If a button shows "LOW (0)" while NOT pressed, the pull-up is missing:
//   -> check /boot/firmware/config.txt has gpio=<pin>=ip,pu AND that you rebooted.

#include <wiringPi.h>
#include <cstdio>

static const int BTN_PINS[6] = {14, 24, 25, 10, 13, 23};   // BTN1 .. BTN6
static const int NUM_BTNS = 6;

int main() {
    if (wiringPiSetupGpio() == -1) {
        printf("FATAL: wiringPiSetupGpio() failed. Are you running with sudo?\n");
        return 1;
    }

    // INPUT only — do NOT call pullUpDnControl; the pull-up comes from config.txt.
    for (int i = 0; i < NUM_BTNS; i++) {
        pinMode(BTN_PINS[i], INPUT);
    }

    printf("Sabon Express — button test (BCM GPIO, active-low). Ctrl+C to quit.\n\n");

    printf("Initial state (NOT pressing anything):\n");
    int prev[NUM_BTNS];
    for (int i = 0; i < NUM_BTNS; i++) {
        prev[i] = digitalRead(BTN_PINS[i]);
        const char *label = (prev[i] == HIGH) ? "OPEN (1) OK" : "LOW (0)  <-- STUCK (no pull-up?)";
        printf("  BTN%d  GPIO%-2d  %s\n", i + 1, BTN_PINS[i], label);
    }

    printf("\n");
    printf("Healthy = every button shows OPEN (1).\n");
    printf("If any shows LOW (0), check config.txt has gpio=<pin>=ip,pu and that you rebooted.\n\n");
    printf("Now press each button and watch for events:\n\n");

    for (;;) {
        for (int i = 0; i < NUM_BTNS; i++) {
            int cur = digitalRead(BTN_PINS[i]);
            if (cur != prev[i]) {
                if (cur == LOW)
                    printf("  BTN%d (GPIO%d)  >>> PRESSED\n", i + 1, BTN_PINS[i]);
                else
                    printf("  BTN%d (GPIO%d)  <<< RELEASED\n", i + 1, BTN_PINS[i]);
                prev[i] = cur;
            }
        }
        delay(10);
    }

    return 0;
}
