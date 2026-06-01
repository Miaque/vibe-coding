# Repository Guidelines

## Project Structure & Module Organization

This is a PlatformIO embedded C++ project for `esp32-s3-devkitm-1` using the Arduino framework. Main firmware code lives in `src/`; the current entry point is `src/main.cpp`. Shared headers belong in `include/`. Project-specific libraries belong under `lib/<LibraryName>/`, with their own source files and optional `library.json`. PlatformIO unit tests belong in `test/`. Board, framework, serial, upload, and library dependency settings are defined in `platformio.ini`.

## Build, Test, and Development Commands

Run commands from the repository root:

- `pio run` builds the firmware for the configured ESP32-S3 environment.
- `pio run -t upload` builds and flashes the board.
- `pio device monitor -b 115200` opens the serial monitor at the configured monitor speed.
- `pio test` runs PlatformIO tests from `test/`.
- `pio run -t clean` removes build artifacts when a clean rebuild is needed.

If `pio` is unavailable, install or activate PlatformIO before changing build assumptions.

## Coding Style & Naming Conventions

Use C++ with Arduino conventions. Keep indentation at 4 spaces, matching `src/main.cpp`. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants/macros, and descriptive names for hardware pins such as `OLED_SDA` and `OLED_SCL`. Prefer small functions that map to hardware behavior or rendering steps. Keep board-specific values in obvious constants near the top of the file unless they become shared configuration.

## Testing Guidelines

Place tests under `test/` and run them with `pio test`. Name test files by behavior or module, for example `test_display_rendering.cpp`. For logic that can be isolated from hardware, prefer unit tests over board-only validation. For hardware-facing changes, also verify on device with `pio run -t upload` and `pio device monitor -b 115200`.

## Commit & Pull Request Guidelines

No local Git history is available in this checkout, so no existing commit convention can be inferred. Use concise imperative commit messages such as `Add OLED progress rendering` or `Fix display initialization pins`. Pull requests should describe the firmware behavior changed, list the board tested, include relevant serial output or screenshots when display behavior changes, and note any required wiring or dependency changes.

## Security & Configuration Tips

Do not commit local credentials, private Wi-Fi settings, or machine-specific upload ports. Keep dependency changes in `platformio.ini` explicit and minimal. When changing pin assignments, document the target wiring in code or the PR description.
