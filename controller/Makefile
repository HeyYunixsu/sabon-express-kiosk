CC = g++
# -MMD -MP emits a .d file per object listing the headers it included, so a
# header edit rebuilds everything that reads it. Without this, changing a
# struct in includes/ left stale objects compiled against the old layout and
# linked happily -- fields were then read at the wrong offsets, which looks
# like impossible logic failures rather than a build problem.
CXXFLAGS = -std=c++17 -Wall -Wextra -Wno-unused-parameter -g -MMD -MP -Iincludes

# Detect OS — affects main binary only
ifeq ($(OS),Windows_NT)
    CXXFLAGS    += -Imock
    LDFLAGS      = -lws2_32
    MOCK_OBJS    = mock/wiringPi.o
    EXE          = main.exe
    TEST_RUNNER  = tests/test_runner.exe
    TEST_LDFLAGS = -lws2_32
else
    LDFLAGS      = -lwiringPi
    MOCK_OBJS    =
    EXE          = main
    TEST_RUNNER  = tests/test_runner
    TEST_LDFLAGS =
endif

.PHONY: all clean test run tools

# -----------------------------------------------------------------------
# Main binary
# -----------------------------------------------------------------------

OBJS = main.o src/pump_control.o src/transaction.o \
       src/utils.o src/hardware_config.o \
       src/socket_server.o $(MOCK_OBJS)

all: $(EXE)

$(EXE): $(OBJS)
	$(CC) -o $(EXE) $(OBJS) $(LDFLAGS)

%.o: %.cpp
	$(CC) $(CXXFLAGS) -c $< -o $@

mock/%.o: mock/%.cpp
	$(CC) $(CXXFLAGS) -c $< -o $@

run: $(EXE)
	./$(EXE)

clean:
	rm -f *.o src/*.o mock/*.o tests/*.o tests/obj/*.o \
	      *.d src/*.d mock/*.d tests/*.d tests/obj/*.d \
	      tests/test_runner tests/test_runner.exe \
	      tools/test_buttons tools/test_buttons.exe \
	      $(EXE) *.gch includes/*.gch src/*.gch
	-rmdir tests/obj 2>/dev/null || true

# -----------------------------------------------------------------------
# Test target — works on BOTH Linux (Pi) and Windows
#
# Module objects are compiled into tests/obj/ with -Imock so the test
# build never depends on real wiringPi hardware or root permissions.
# The main binary's src/*.o are left untouched.
# -----------------------------------------------------------------------

# Test build always uses mock, regardless of host OS
TEST_CXXFLAGS = -std=c++17 -Wall -Wextra -Wno-unused-parameter -g -MMD -MP -Iincludes -Imock

TEST_OBJS = tests/run_tests.o \
            tests/test_utils.o \
            tests/test_socket_cmd.o tests/test_mock.o tests/test_hardware.o \
            tests/test_transaction_json.o tests/test_app_state.o \
            tests/test_product_config.o tests/test_transaction_write.o \
            tests/test_module_linkage.o tests/test_input_validation.o tests/test_config_loading.o \
            tests/test_armed_state.o tests/test_logging.o \
            tests/test_prime.o tests/test_prices.o tests/test_dry_tank.o             tests/test_multi_press.o \
            tests/test_unclaimed.o tests/test_dispense_commands.o \
            tests/test_socket_integration.o

# Source modules compiled with mock support into tests/obj/
# (separate from src/*.o used by the main binary)
TEST_MODULE_OBJS = tests/obj/pump_control.o tests/obj/utils.o \
                   tests/obj/hardware_config.o \
                   tests/obj/socket_server.o tests/obj/transaction.o \
                   mock/wiringPi.o

tests/obj/%.o: src/%.cpp
	@mkdir -p tests/obj
	$(CC) $(TEST_CXXFLAGS) -c $< -o $@

tests/%.o: tests/%.cpp
	$(CC) $(TEST_CXXFLAGS) -Itests -c $< -o $@

mock/wiringPi.o: mock/wiringPi.cpp
	$(CC) $(TEST_CXXFLAGS) -c $< -o $@

test: $(TEST_OBJS) $(TEST_MODULE_OBJS)
	$(CC) -o $(TEST_RUNNER) $(TEST_OBJS) $(TEST_MODULE_OBJS) $(TEST_LDFLAGS)
	./$(TEST_RUNNER)

# Standalone hardware diagnostics. Not part of `all` -- they need real GPIO,
# so they only build and run on the Pi.
tools: tools/test_buttons
	@echo "Built tools/test_buttons -- run with: sudo ./tools/test_buttons"

tools/test_buttons: tools/test_buttons.cpp
	$(CC) -std=c++17 -Wall -o $@ $< -lwiringPi

# Header dependencies discovered by -MMD. Leading '-' so a missing .d on a
# first build is not an error.
-include $(OBJS:.o=.d)
-include $(TEST_OBJS:.o=.d)
-include $(TEST_MODULE_OBJS:.o=.d)
