# TIDAL Shuffle & Repeat for Flyouts

A [TidaLuna](https://github.com/Inrixia/TidaLuna) plugin that exposes TIDAL's
**shuffle** and **repeat** controls to the Windows **System Media Transport
Controls (SMTC)** — so media/volume flyouts like
[FluentFlyout](https://github.com/unchihugo/FluentFlyout) (and the native Windows
media flyout) can toggle them.

By default, TIDAL (an Electron/Chromium app) does **not** advertise shuffle/repeat
to the SMTC, so those buttons appear greyed out in flyouts. This plugin fixes that.

## What it does

- Publishes a full SMTC session for TIDAL with **shuffle + repeat** exposed,
  plus title / artist / album art / play-pause-next-previous / seek timeline.
- **Bidirectional sync**: toggling shuffle/repeat in the flyout controls TIDAL,
  and changing them in TIDAL updates the flyout.
- Replaces Chromium's own (shuffle/repeat-less) media session so only this rich
  session is shown.

## How it works

- A small native addon (Rust + [napi-rs](https://napi.rs/), using the Windows
  `windows` crate) creates the SMTC session via
  `ISystemMediaTransportControlsInterop::GetForWindow` and wires the
  shuffle/repeat change-requested handlers. The compiled `.node` is embedded
  (base64) in the bundle, so the plugin is self-contained.
- The renderer side drives TIDAL through `@luna/lib`'s `PlayState`
  (`setShuffle` / `setRepeatMode` / play / pause / next / previous) and mirrors
  TIDAL's state + metadata back onto the SMTC session.
- Chromium's media session is disabled with the Electron switch
  `--disable-features=MediaSessionService,HardwareMediaKeyHandling`. The plugin
  relaunches TIDAL once with this flag if needed.

## Settings

- **Optimize startup (avoid restarts)** — writes the flag into TIDAL's autostart
  command so every launch already carries it (no relaunch after the first time).
  Reversible by turning the toggle off.

## Requirements / notes

- Windows only. TIDAL desktop is 32-bit Electron (ia32); the embedded binary
  targets `i686-pc-windows-msvc`.
- Without "Optimize startup", launches that lack the flag trigger one brief
  automatic relaunch.

## Building the native addon (for contributors)

```bash
# from smtc-bridge/ (needs Rust + the i686 target + VS Build Tools)
rustup target add i686-pc-windows-msvc
# inside a VS x86 dev environment (vcvarsall.bat x86):
pnpm install
napi build --platform --release --target i686-pc-windows-msvc
# then re-embed the .node as base64 into the plugin's src/native-bin.ts
```
