# WebAudio Waterfall Spectrogram

## Demo

[https://ker2x.github.io/webaudio-waterfall/](https://ker2x.github.io/webaudio-waterfall/)

Real-time “waterfall” spectrogram of your microphone input in the browser. It uses the Web Audio API for FFT data and Canvas 2D for rendering. No external libraries required.


## Privacy

- Your audio stays local in your browser. The app processes microphone data using the Web Audio API and draws pixels to a canvas.
- No audio is uploaded to any server by this application. There is no analytics or network transmission of audio.
- You can revoke microphone permission at any time in your browser’s site settings.

### Privacy audit

Audit conclusion: No audio data is sent to any server, never saved or transmitted by the application.

- Audio capture
  - The app uses getUserMedia to obtain microphone input locally in the browser.
  - The audio stream is processed entirely in the client (Web Audio API) with an AnalyserNode and a Gain node for sensitivity.
  - There is no code that streams or uploads captured audio data to any remote server.

- Data flow and processing
  - Magnitude data (frequency spectrum) is computed and passed to the rendering path in-memory.
  - The rendering is done on a canvas (and an offscreen buffer) within the browser; no data is transmitted over the network as part of the visualization pipeline.
  - No attempts to serialize, upload, or send audio or spectral data to a server are present in the code paths.

- Persistence and local storage
  - Settings are intentionally not persisted: saveSettings(s) is a no-op.
  - This means no microphone or usage data is stored locally beyond in-memory runtime state.

- Networking and external calls
  - There are no fetch/XHR/WebSocket calls or analytics hooks in the provided code that would transmit audio or usage data.
  - The UI and rendering logic operate entirely on-device.

- Security/privacy notes
  - Since microphone data remains in the browser’s memory and is not uploaded, the design aligns with a privacy-preserving, local-only workflow.
  - When permission is granted, the application operates only locally; there is no evidence of data leaving the client.

Bottom line

- No audio data is sent to servers, anonymized or otherwise.
- No audio data is saved or persisted to disk or remote endpoints.
- No server communications are invoked by the code for audio or spectral data.

## Features
- Live spectrogram rendering with adjustable FFT size, decimation (lines per second), and dynamic range.
- Visual controls: contrast, luminosity (brightness), and input sensitivity (microphone gain).
- Linear or Mel-like frequency axis with lower bound at 20 Hz.
- Settings persist in localStorage.
- Efficient rendering using an offscreen buffer for smooth scrolling.

## Getting Started
1. Clone or download the repository.
2. Serve the project with any static HTTP server (required for getUserMedia permissions to work reliably).
   - Node example: `npx http-server -p 8080` from the project root.
3. Open `http://localhost:8080/` in a modern browser (Chrome, Edge, Firefox, Safari).
4. Click “Start” and grant microphone permission.

## Controls
- Input: select a microphone device after permission is granted.
- FFT: choose an FFT size up to 32768 (native AnalyserNode). Larger values are internally capped.
- lines/s: how many spectrogram rows per second are drawn (decimation). Higher = more temporal detail.
- Dyn range (dB): window of decibels mapped into the 0..1 color range.
- Contrast / Luminosity: visual tuning of the color map mapping.
- Sensitivity: input gain applied to the microphone signal.
- Psychoacoustic frequency scale (Mel): toggles a perceptual (Mel) horizontal frequency axis mapping. Enabled by default.

## Files of Interest
- `index.html` — minimal bootstrap HTML. The UI is created dynamically by JavaScript.
- `js/app.js` — the main application with rendering (Waterfall) and audio (AudioEngine) logic.
- `css/style.css` — base styles from HTML5 Boilerplate with helper utilities.

## Browser Permissions
The app requires microphone access. If you don’t see device labels, click Start once to grant permission and the device list will refresh.

## Troubleshooting
- I clicked Start but nothing happens / permission denied:
  - Make sure you serve the site over http(s). getUserMedia is blocked on file:// and often on unsecured origins.
  - When the browser prompts for microphone access, click Allow. If you blocked it accidentally, open the site permissions and allow the microphone, then click Start again.
- No microphones listed or labels are generic:
  - Device labels are only available after permission is granted. Click Start once to grant permission, then the list will refresh with names.
- No sound or flat spectrogram:
  - Ensure the correct input device is selected.
  - Increase Sensitivity if the signal is very low.
  - Some audio interfaces expose multiple channels or require enabling the mic in the OS sound settings.
- “Microphone is in use” or NotReadableError:
  - Close other applications that may be using the microphone (video conferencing, DAWs), then click Start to retry.
- “No device found” or NotFoundError:
  - Unplug/replug your microphone or choose a different input from the selector and retry.
- Safari/Firefox specifics:
  - Safari may require an initial user gesture (click) and secure context (https). Firefox can delay device labels until permission is granted.

## Known Limitations
- Requires a modern browser with Web Audio API and getUserMedia support.
- FFT sizes are capped to the AnalyserNode maximum of 32768 in the current build; larger sizes are not available.
- CPU and battery usage increase with large FFT sizes and high lines/s.
- When the tab is hidden, drawing is throttled; the app queues or sparsifies updates to avoid heavy background work.
- Mobile browsers may suspend audio processing aggressively to save power.

## Development
- The code is plain ES2015+ JavaScript; no bundler is required to run in the browser.
- Webpack configs are present if you decide to bundle/optimize, but the app also runs unbundled.

## License
MIT. See `LICENSE.txt`.
