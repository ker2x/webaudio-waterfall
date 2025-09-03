# Improvements Proposal: WebAudio Waterfall Spectrogram

Date: 2025-09-03
Author: Junie (JetBrains)

## Goals
Enhance usability, maintainability, and performance while keeping the app lightweight and framework-free.

## Short-Term (1–2 days)
- UX and Resilience
  - Re-enable Start after permission errors and show a clear retry message.
  - Add an ARIA live region for status updates; ensure focus management after actions.
- Config and Constants
  - Extract axis paddings (22px, 48px), frequency clamps (20 Hz, 16 kHz), and fonts into named constants.
  - Move color map parameters to a small module or section with comments.
- Documentation
  - Expand README with privacy note (audio stays local), troubleshooting (no sound/device), and known limitations.
- Code Quality
  - Add JSDoc typedefs for settings, axis context, and public APIs of Waterfall and AudioEngine.

## Medium-Term (3–5 days)
- Color Maps and Themes
  - Offer 2–3 selectable color maps (e.g., Turbo, Viridis, Grayscale). Persist selection.
  - Dark/light UI theme toggle; ensure canvas overlays adapt.
- Layout
  - Make axis sizes configurable; add a “compact” mode.
  - Improve responsive behavior on mobile; adapt toolbar wrapping and canvas height calculation.
- Performance
  - Optionally skip drawing axes every frame; only redraw on size/setting change to save CPU.
  - Introduce a “max FPS” cap to decouple draw rate from rAF on fast machines.

## Longer-Term (1–2 weeks)
- Custom FFT Path (Beyond 32768)
  - Implement an AudioWorklet-based sample capture and JS/WASM radix-2 FFT for very large windows.
  - Add window functions (Hann, Hamming, Blackman) and overlap options.
- Export and Sharing
  - Allow exporting a PNG snapshot and/or short MP4 of the canvas.
  - Add option to log peak frequencies or save averaged spectra.
- Modularity and Types
  - Split into ES modules: renderer, engine, ui, utils.
  - Consider TypeScript for stronger typings and better editor experience.
- Testing and CI
  - Add basic unit tests for utilities (mapping, formatting), and a headless canvas smoke test.
  - GitHub Actions to run lint and tests on PRs.

## Rough Effort Estimates
- Short-Term: 1–2 days
- Medium-Term: 3–5 days
- Long-Term: 1–2 weeks

## Risks and Mitigations
- getUserMedia permissions can be flaky on file:// — recommend serving over http(s); document this prominently.
- Large FFTs are CPU-heavy — expose clear guidance and defaults; provide a safe cap.
- Cross-browser differences — test Chrome, Firefox, Safari; guard features with capability checks.

## Success Metrics
- Lower CPU usage at default settings (axes drawn less frequently).
- Improved accessibility scores (Lighthouse/axe).
- Fewer user-reported issues around permission handling and device selection.
