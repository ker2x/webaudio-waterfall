/*
WebAudio Waterfall Spectrogram

Overview
- Purpose: Real-time and long-term spectrogram ("waterfall") visualization of microphone input in the browser.
- Dependencies: None (vanilla JS + Web Audio API + Canvas 2D).
- Key features:
  - Configurable FFT size (up to 1,048,576 using a custom FFT path), decimation (rows per second), dynamic range.
  - Visual controls: contrast, luminosity (brightness), microphone sensitivity (input gain).
  - Frequency axis at the bottom (linear or Mel scale with 20 Hz lower bound); time axis at the right.
  - Persistence of settings in localStorage.
  - Designed for long-term monitoring; efficient row scrolling via an offscreen canvas.

Architecture at a glance
- UI bootstrapping: buildUI() dynamically creates controls and canvas, and populateDevices() fills input selector.
- Settings: loadSettings()/saveSettings() persist user adjustments between sessions.
- Rendering: class Waterfall draws rows to an offscreen canvas then blits to the visible canvas; also draws axes + overlay.
- Audio processing: class AudioEngine routes microphone to either:
  - AnalyserNode path for FFT sizes ≤ 32768 (native FFT), or
  - Custom path for FFT sizes > 32768 using an AudioWorklet to capture samples and a JS radix-2 FFT.
- Data flow: mic → input GainNode (sensitivity) → [AnalyserNode | AudioWorkletNode] → magnitudes → Waterfall.drawRow().

Coordinate system + axes
- Horizontal: frequency from left (low) to right (high). Minimum frequency is clamped to 20 Hz.
  - Linear: pixels map linearly from 20 Hz to Nyquist.
  - Mel: pixels map via mel(f) = 2595*log10(1 + f/700), using inverse to place bins; ticks at perceptual frequencies.
- Vertical: time increases downward; each new FFT row is drawn at y=0 and the buffer scrolls down.

Performance notes
- Offscreen canvas is used to scroll content by 1 px per row (fast blit instead of repainting the whole image).
- In custom FFT mode, processing cadence is limited by decimation and a fraction of the window length to avoid CPU spikes.
- For very large FFTs, consider lowering decimation to < 1 row/s to visualize long windows.

File layout highlights
- Helper functions: $, loadSettings/saveSettings, colormap, formatDb.
- Class Waterfall: rendering pipeline, axes, overlay, contrast/brightness application.
- Class AudioEngine: start/stop, analyser vs custom-FFT selection, decimation, dynamic range normalization, sensitivity.
- FFT helpers: hannWindow(), bitReverseIndices(), fftRadix2().
- App bootstrap: startApp() wires UI, Waterfall, and AudioEngine together.
*/

(async function () {
  const $ = (sel) => document.querySelector(sel);
  const ui = {
    startBtn: null,
    stopBtn: null,
    deviceSelect: null,
    fftSize: null,
    decimation: null,
    dynRange: null,
    canvas: null,
    status: null,
  };

/**
 * Load persisted settings from localStorage.
 * Returns a settings object with sane defaults if none are stored or parsing fails.
 * Keys: deviceId, fftSize, decimation, dynRange, contrast, luminosity, sensitivity, logFreqScale
 */
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('waterfall_settings') || '{}');
      return Object.assign({
        deviceId: 'default',
        fftSize: 2048,
        decimation: 20, // rows per second
        dynRange: 80, // dB dynamic range
        contrast: 1.0, // visual contrast multiplier
        luminosity: 0.0, // visual brightness offset
        sensitivity: 1.0, // input gain multiplier
        logFreqScale: false, // linear vs log frequency scale
      }, s);
    } catch (e) {
      return { deviceId: 'default', fftSize: 2048, decimation: 20, dynRange: 80, contrast: 1.0, luminosity: 0.0, sensitivity: 1.0, logFreqScale: false };
    }
  }

/**
 * Persist settings to localStorage under 'waterfall_settings'.
 * @param {Object} s
 */
  function saveSettings(s) {
    localStorage.setItem('waterfall_settings', JSON.stringify(s));
  }

  // Color map: maps 0..1 -> RGB
/**
 * Map a normalized magnitude in [0,1] to an RGB color.
 * This is a simple Turbo-like gradient tailored for spectrograms.
 * @param {number} v - normalized value [0,1]
 * @returns {[number, number, number]} - [r,g,b] in 0..255
 */
  function colormap(v) {
    // Turbo-like simple gradient
    const x = Math.max(0, Math.min(1, v));
    const r = Math.floor(255 * Math.min(1, Math.max(0, 1.5 * x - 0.2)));
    const g = Math.floor(255 * Math.min(1, Math.max(0, 1.5 * (1 - Math.abs(x - 0.5) * 2))));
    const b = Math.floor(255 * Math.min(1, Math.max(0, 1.5 * (1 - x) - 0.2)));
    return [r, g, b];
  }

  function formatDb(val) {
    return `${val.toFixed(1)} dB`;
  }

/**
 * Waterfall
 * Renders a scrolling spectrogram into a canvas. Uses an offscreen buffer canvas to efficiently scroll
 * previous rows by 1 pixel when drawing new data. Also renders axes (frequency bottom, time right)
 * and a small status overlay.
 *
 * Options (opts):
 * - contrast: number (default 1.0)
 * - luminosity: number (default 0.0)
 * - logFreq: boolean (default false) — when true, frequency axis uses Mel mapping.
 */
  class Waterfall {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.opts = Object.assign({ contrast: 1.0, luminosity: 0.0, logFreq: false }, opts || {});
      this.height = canvas.height;
      this.width = canvas.width;

      // Offscreen canvas for efficient scrolling (tiling approach is overkill here)
      this.buff = document.createElement('canvas');
      this.buff.width = this.width;
      this.buff.height = this.height;
      this.bctx = this.buff.getContext('2d');

      this.imageData = this.bctx.createImageData(this.width, 1); // one-row buffer

      // Axis/overlay timing and context providers
      this.lastOverlayTs = 0;
      this.axisContextProvider = null; // function returning { sampleRate, fftSize, decimation, startedAt, now }
    }

    clear() {
      this.bctx.clearRect(0, 0, this.width, this.height);
      this.ctx.clearRect(0, 0, this.width, this.height);
    }

    /**
     * Supply a function that returns axis context used by drawRow/drawAxes.
     * Expected shape: { sampleRate, fftSize, decimation, startedAt, now }
     */
    setAxisContextProvider(fn) {
      this.axisContextProvider = fn;
    }

    /**
     * Resize the visible and buffer canvases to device pixels.
     * Should be called on window resize; use fitCanvasToDisplay() to compute w/h.
     */
    setSize(w, h) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.buff.width = w;
      this.buff.height = h;
      this.imageData = this.bctx.createImageData(this.width, 1);
    }

/**
     * Draw one FFT magnitude row.
     * @param {Float32Array|number[]} mags01 - magnitudes normalized to [0,1], bins from 0..Nyquist.
     * Resamples horizontally to canvas width using linear interpolation and applies visual adjustments.
     */
    drawRow(mags01) {
      // Scroll buff down by 1 pixel
      this.bctx.drawImage(this.buff, 0, 0, this.width, this.height - 1, 0, 1, this.width, this.height - 1);

      // Convert normalized magnitudes (0..1) to colors into imageData row
      const row = this.imageData.data;
      const bins = mags01.length;
      // Render left-to-right across canvas width: resample to width
      const ac = this.axisContextProvider ? this.axisContextProvider() : null;
      const sampleRate = ac && ac.sampleRate ? ac.sampleRate : 48000;
      const nyquist = sampleRate / 2;
      // Frequency bounds: lower bound 20 Hz, upper bound 16 kHz (or Nyquist if lower)
      const fmax = Math.min(16000, nyquist);
      let fmin = Math.max(20, nyquist / 20000);
      if (fmin >= fmax) fmin = fmax * 0.9999;
      // Precompute mel scale endpoints for [fmin, fmax]
      const mel = (f) => 2595 * Math.log10(1 + f / 700);
      const melMin = mel(fmin);
      const melMax = mel(fmax);
      const denomMel = Math.max(1e-9, (melMax - melMin));
      for (let x = 0; x < this.width; x++) {
        let idxF;
        if (this.opts.logFreq) { // mel scale mapping instead of pure log
          const frac = x / (this.width - 1);
          // inverse mel to freq: f = 700*(10^(mel/2595)-1)
          const melVal = melMin + frac * denomMel;
          const f = 700 * (Math.pow(10, melVal / 2595) - 1);
          const binF = (f / nyquist) * (bins - 1);
          idxF = Math.max(0, Math.min(bins - 1, binF));
        } else {
          const frac = x / (this.width - 1);
          const f = fmin + frac * (fmax - fmin);
          const binF = (f / nyquist) * (bins - 1);
          idxF = Math.max(0, Math.min(bins - 1, binF));
        }
        const i0 = Math.floor(idxF);
        const i1 = Math.min(bins - 1, i0 + 1);
        const t = idxF - i0;
        let v = mags01[i0] * (1 - t) + mags01[i1] * t;
        // Apply visual adjustments: contrast and luminosity
        // v' = clamp( ((v-0.5)*contrast + 0.5) + luminosity )
        v = ((v - 0.5) * this.opts.contrast + 0.5) + this.opts.luminosity;
        v = Math.max(0, Math.min(1, v));
        const [r, g, b] = colormap(v);
        const off = x * 4;
        row[off] = r; row[off + 1] = g; row[off + 2] = b; row[off + 3] = 255;
      }
      // Put the row at y=0
      this.bctx.putImageData(this.imageData, 0, 0);

      // Blit buffer to visible canvas
      this.ctx.drawImage(this.buff, 0, 0);

      // Always draw axes every frame to avoid flicker
      this.drawAxes();
    }


/** Draw frequency and time axes on top of the spectrogram. */
    drawAxes() {
      const ctx = this.ctx;
      ctx.save();
      // slight translucent background strip at bottom for freq axis
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, this.height - 22, this.width, 22);
      // and right strip for time axis
      ctx.fillRect(this.width - 48, 0, 48, this.height);

      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // Frequency axis along bottom
      const ac = this.axisContextProvider ? this.axisContextProvider() : null;
      const sampleRate = ac && ac.sampleRate ? ac.sampleRate : 48000;
      const fftSize = ac && ac.fftSize ? ac.fftSize : 2048;
      const nyquist = sampleRate / 2;
      const fmax = Math.min(16000, nyquist);
      // choose tick step aiming ~8-12 labels (linear scale)
      const targetTicks = Math.max(6, Math.min(12, Math.floor(this.width / 120)));
      const rawStep = fmax / targetTicks;
      const niceSteps = [10,20,50,100,200,500,1000,2000,5000,10000];
      let step = niceSteps[0];
      for (const s of niceSteps) { if (s >= rawStep) { step = s; break; } }
      const yAxisY = this.height - 22 + 0.5; // align to device pixel
      ctx.beginPath();
      ctx.moveTo(0.5, yAxisY);
      ctx.lineTo(this.width + 0.5, yAxisY);
      ctx.stroke();
      if (!this.opts.logFreq) {
        let fmin = 20;
        if (fmin >= fmax) fmin = fmax * 0.9999;
        const fStart = Math.max(fmin, Math.ceil(fmin / step) * step);
        for (let f = fStart; f <= fmax + 1; f += step) {
          const x = (f / nyquist) * (this.width - 1);
          const xi = Math.round(x) + 0.5;
          ctx.beginPath();
          ctx.moveTo(xi, yAxisY);
          ctx.lineTo(xi, yAxisY + 5);
          ctx.stroke();
          const label = f >= 1000 ? (f/1000).toFixed(f % 1000 === 0 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz';
          ctx.fillText(label, x, yAxisY + 6);
        }
      } else {
        // Mel scale ticks at perceptually spaced frequencies
        let fmin = Math.max(20, nyquist / 20000);
        const fmaxMel = Math.min(16000, nyquist);
        if (fmin >= fmaxMel) fmin = fmaxMel * 0.9999;
        const mel = (f) => 2595 * Math.log10(1 + f / 700);
        const melMin = mel(fmin);
        const melMax = mel(fmaxMel);
        const tickFreqs = [20,50,100,200,300,500,700,1000,1500,2000,3000,5000,8000,10000,15000,16000,20000];
        for (const fRaw of tickFreqs) {
          const f = Math.min(fmaxMel, Math.max(fmin, fRaw));
          if (f < fmin || f > fmaxMel) continue;
          const x = (mel(f) - melMin) / (melMax - melMin) * (this.width - 1);
          const xi = Math.round(x) + 0.5;
          ctx.beginPath();
          ctx.moveTo(xi, yAxisY);
          ctx.lineTo(xi, yAxisY + 5);
          ctx.stroke();
          const label = f >= 1000 ? (f/1000).toFixed(f % 1000 === 0 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz';
          ctx.fillText(label, x, yAxisY + 6);
        }
      }

      // Time axis along right side (top=now, increasing downward)
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const decim = ac && ac.decimation ? ac.decimation : 20; // rows per second
      // Each pixel row corresponds to 1/decim seconds
      const secondsVisible = this.height / decim;
      // choose nice time step
      const niceTime = [0.2,0.5,1,2,5,10,30,60,120,300,600,1800,3600];
      let tStep = niceTime[0];
      const targetTimeTicks = Math.max(4, Math.min(12, Math.floor(this.height / 80)));
      for (const s of niceTime) { if (s >= secondsVisible / targetTimeTicks) { tStep = s; break; } }
      const rightX = this.width - 48 + 0.5; // align to device pixel
      ctx.beginPath();
      ctx.moveTo(rightX, 0.5);
      ctx.lineTo(rightX, this.height + 0.5);
      ctx.stroke();
      for (let t = 0; t <= secondsVisible + 0.001; t += tStep) {
        const y = t * decim; // pixels from top
        ctx.beginPath();
        ctx.moveTo(rightX, y);
        ctx.lineTo(rightX + 6, y);
        ctx.stroke();
        const lab = t >= 60 ? (t/60).toFixed(t % 60 === 0 ? 0 : 1) + ' min' : t.toFixed(tStep < 1 ? 1 : 0) + ' s';
        ctx.fillText(lab, this.width - 4, y);
      }
      ctx.restore();
    }
  }

/**
 * AudioEngine
 * Captures microphone audio and provides magnitude spectra frames to a callback.
 * Two modes:
 * - Analyser path (fftSize ≤ 32768): uses WebAudio AnalyserNode to compute frequency data bytes.
 * - Custom path (fftSize > 32768): captures raw samples via AudioWorklet, applies Hann window, radix-2 FFT,
 *   and computes normalized magnitudes (0..1) relative to current peak.
 * Public setters control decimation (rows/s), fftSize, dynamic range, and sensitivity.
 */
  class AudioEngine {
    constructor(onFrame) {
      // Hidden tab handling
      this._hidden = false;
      this._rowQueue = [];
      this._maxQueuedRows = 10000;
      this._hiddenTimer = null;
      this.onFrame = onFrame;
      this.audio = null;
      this.analyser = null;
      this.srcNode = null;
      this.inputGain = null;
      this.decimation = 20; // rows per second
      this.fftSize = 2048; // power of two
      this.smoothingTimeConstant = 0;
      this.dynRange = 80; // dB
      this.minDecibels = -100;
      this.maxDecibels = -20;
      this.sensitivity = 1.0; // gain multiplier
      this._timer = 0;
      this._nextDue = 0;
      this._freqData = null;
      this._running = false;
      this._deviceId = 'default';
    }

    get settings() {
      return {
        decimation: this.decimation,
        fftSize: this.fftSize,
        dynRange: this.dynRange,
        deviceId: this._deviceId,
      };
    }

/**
     * Start audio capture and processing.
     * Chooses analyser vs custom path based on fftSize, then begins frame production.
     * @param {string} deviceId
     */
    async start(deviceId) {
      if (!this.audio) this.audio = new (window.AudioContext || window.webkitAudioContext)();
      const sr = this.audio.sampleRate || 48000;
      if (this._running) return;
      this._running = true;
      this._deviceId = deviceId || this._deviceId || 'default';

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: this._deviceId === 'default' ? true : { deviceId: { exact: this._deviceId } },
      });
      this.srcNode = this.audio.createMediaStreamSource(stream);

      // Insert input gain for sensitivity control
      this.inputGain = this.audio.createGain();
      this.inputGain.gain.value = this.sensitivity;
      this.srcNode.connect(this.inputGain);

      this.analyser = this.audio.createAnalyser();
      this.applyAnalyserSettings();
      this.inputGain.connect(this.analyser);
      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this._nextDue = this.audio.currentTime;
      this._startedAt = this.audio.currentTime;
      this._tick();
    }

/** Stop processing. */
    stop() {
      if (this._hiddenTimer) { clearInterval(this._hiddenTimer); this._hiddenTimer = null; }
      this._running = false;
    }

/** Apply analyser parameters and allocate buffer. */
    applyAnalyserSettings() {
      if (!this.analyser) return;
      // Clamp fftSize to allowed values
      const allowed = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
      if (!allowed.includes(this.fftSize)) {
        // pick closest
        let best = allowed[0], d = Infinity;
        for (const a of allowed) { const dd = Math.abs(a - this.fftSize); if (dd < d) { d = dd; best = a; } }
        this.fftSize = best;
      }
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0; // no smoothing

      // We will use getByteFrequencyData and map 0..255 to dB range; keep defaults reasonable
      this.analyser.minDecibels = -100;
      this.analyser.maxDecibels = -20;

      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }

/** Set the number of rows per second to draw. */
    setDecimation(rowsPerSecond) {
      this.decimation = Math.max(1, Math.min(2000, rowsPerSecond));
    }

/** Set FFT size (rounded to nearest pow2) but capped to AnalyserNode max (32768). */
    setFFTSize(fft) {
      this.fftSize = this._ensurePowerOfTwo(fft);
      if (this.fftSize > 32768) this.fftSize = 32768;
      this.applyAnalyserSettings();
    }


/** Set visual dynamic range in dB (used to map analyser/custom magnitudes into [0,1]). */
    setDynRange(db) {
      this.dynRange = Math.max(10, Math.min(140, db));
    }

/** Round to nearest power of two within [32, 1,048,576]. */
    _ensurePowerOfTwo(n) {
      // return nearest power-of-two integer within [32, 1048576]
      n = Math.max(32, Math.min(1048576, n|0));
      const p = 1 << Math.round(Math.log2(n));
      return p;
    }

/** Set microphone input gain multiplier (sensitivity) in [0.01, 10]. */
    setSensitivity(gain) {
      // Clamp to a safe range; very high values may clip
      const g = Math.max(0.01, Math.min(10, gain));
      this.sensitivity = g;
      if (this.inputGain) this.inputGain.gain.value = g;
    }

/**
     * Analyser path animation loop. Reads byte frequency data and maps it into normalized magnitudes
     * using the configured dynamic range window ending at maxDecibels.
     */
    _deliverRow(m) {
      if (!this._hidden) {
        this.onFrame(m);
      } else {
        // queue with cap
        if (this._rowQueue.length >= this._maxQueuedRows) {
          const excess = this._rowQueue.length - this._maxQueuedRows + 1;
          if (excess > 0) this._rowQueue.splice(0, excess);
        }
        this._rowQueue.push(m);
      }
    }

    setHidden(hidden) {
      const wasHidden = this._hidden;
      this._hidden = !!hidden;
      // Hidden timers for analyser path to keep producing at a low rate
      if (this._hidden && !this._hiddenTimer) {
        const intervalMs = Math.max(50, Math.round(1000 / Math.min(10, Math.max(1, this.decimation)))) ;
        this._hiddenTimer = setInterval(() => {
          if (!this._running) return;
          // produce one frame depending on mode
          if (this.analyser && this._freqData) {
            // analyser path sampling
            this.analyser.getByteFrequencyData(this._freqData);
            const bins = this._freqData.length;
            const mags = new Float32Array(bins);
            const minDb = this.analyser.minDecibels;
            const maxDb = this.analyser.maxDecibels;
            const range = maxDb - minDb;
            for (let i = 0; i < bins; i++) {
              const byte = this._freqData[i];
              const db = minDb + (byte / 255) * range;
              const norm = (db - (maxDb - this.dynRange)) / this.dynRange;
              mags[i] = Math.max(0, Math.min(1, norm));
            }
            this._deliverRow(mags);
          }
        }, intervalMs);
      } else if (!this._hidden && this._hiddenTimer) {
        clearInterval(this._hiddenTimer);
        this._hiddenTimer = null;
      }
      if (!this._hidden) {
        // Flush queued rows
        const q = this._rowQueue; this._rowQueue = [];
        for (let i = 0; i < q.length; i++) this.onFrame(q[i]);
        // Resume audio context if needed
        if (this.audio && this.audio.state !== 'running') {
          this.audio.resume().catch(() => {});
        }
      }
    }

    _tick = () => {
      // analyser path rendering
      if (!this._running) return;
      this._timer = requestAnimationFrame(this._tick);
      const now = this.audio.currentTime;
      const interval = 1 / this.decimation;
      if (now + 0.002 < this._nextDue) return; // wait
      // Read frequency data
      this.analyser.getByteFrequencyData(this._freqData);

      // Convert 0..255 byte values to normalized 0..1 using dynamic range
      // Map: 0 -> minDecibels, 255 -> maxDecibels
      const bins = this._freqData.length;
      const mags = new Float32Array(bins);
      const minDb = this.analyser.minDecibels;
      const maxDb = this.analyser.maxDecibels;
      const range = maxDb - minDb; // negative to less negative
      for (let i = 0; i < bins; i++) {
        const byte = this._freqData[i];
        const db = minDb + (byte / 255) * range;
        // normalize using dynRange window ending at maxDb
        const norm = (db - (maxDb - this.dynRange)) / this.dynRange;
        mags[i] = Math.max(0, Math.min(1, norm));
      }

      this._deliverRow(mags);
      this._nextDue = now + interval;
    }
  }


  // UI setup
/**
   * Dynamically constructs the control toolbar and canvas.
   * Binds references into the `ui` object for later wiring.
   */
  function buildUI() {
    const container = document.createElement('div');
    container.style.padding = '8px';
    // Ensure page uses full viewport and no default margins introducing extra whitespace
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
    container.innerHTML = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center">
        <button id="wf-start">Start</button>
        <button id="wf-stop" disabled>Stop</button>
        <label>Input <select id="wf-device"></select></label>
        <label>FFT <select id="wf-fft">
          ${[512,1024,2048,4096,8192,16384,32768].map(v=>`<option value="${v}">${v}</option>`).join('')}
        </select></label>
        <label>lines/s <input id="wf-dec" type="number" min="1" max="2000" step="1" style="width:6em"/></label>
        <label>Dyn range (dB) <input id="wf-dyn" type="number" min="10" max="140" step="1" style="width:5em"/></label>
        <label>Contrast <input id="wf-contrast" type="range" min="0.1" max="3" step="0.01"/></label>
        <label>Luminosity <input id="wf-lum" type="range" min="-0.5" max="0.5" step="0.01"/></label>
        <label>Sensitivity <input id="wf-sens" type="range" min="0.01" max="10" step="0.01"/></label>
        <label><input id="wf-log" type="checkbox"/> Mel Freq</label>
        <span id="wf-status" role="status" aria-live="polite"></span>
      </div>
      <div id="wf-wrap" style="margin-top:8px; position:relative">
        <canvas id="wf-canvas" style="width:100%; background:#000; display:block"></canvas>
      </div>
    `;
    document.body.innerHTML = '';
    document.body.appendChild(container);

    ui.startBtn = $('#wf-start');
    ui.stopBtn = $('#wf-stop');
    ui.deviceSelect = $('#wf-device');
    ui.fftSize = $('#wf-fft');
    ui.decimation = $('#wf-dec');
    ui.dynRange = $('#wf-dyn');
    ui.contrast = $('#wf-contrast');
    ui.luminosity = $('#wf-lum');
    ui.sensitivity = $('#wf-sens');
    ui.logFreq = $('#wf-log');
    ui.canvas = $('#wf-canvas');
    ui.wrap = document.querySelector('#wf-wrap');
    ui.status = $('#wf-status');
  }

/**
   * Fill the input device selector. Requires microphone permission to reveal labels.
   * If permission is not yet granted, shows a status hint.
   */
  async function populateDevices(selectedId) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      ui.deviceSelect.innerHTML = '';
      const def = document.createElement('option');
      def.value = 'default';
      def.textContent = 'Default microphone';
      ui.deviceSelect.appendChild(def);
      for (const d of inputs) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Input ${d.deviceId.slice(0,6)}`;
        ui.deviceSelect.appendChild(opt);
      }
      ui.deviceSelect.value = selectedId || 'default';
    } catch (e) {
      ui.status.textContent = 'Device enumeration blocked until permission is granted.';
    }
  }

/**
   * Compute canvas pixel dimensions according to CSS size and devicePixelRatio.
   * Returns integers width/height to set canvas backing store properly.
   */
  function fitCanvasToDisplay(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(100, Math.floor(rect.width * dpr));
    const h = Math.max(100, Math.floor(rect.height * dpr));
    return { w, h };
  }

/**
   * Application bootstrap. Builds UI, instantiates Waterfall and AudioEngine, wires events,
   * restores settings, and starts/stops audio on button clicks.
   */
  function startApp() {
    const settings = loadSettings();
    buildUI();

    // Helper to size canvas to fill remaining viewport height under the toolbar
    function sizeCanvasToViewport() {
      const vpH = window.innerHeight || document.documentElement.clientHeight;
      const toolbar = document.querySelector('body > div > div'); // the controls div inside container
      const toolbarH = toolbar ? Math.ceil(toolbar.getBoundingClientRect().height) : 0;
      const margins = 8 + 8; // top padding (8) + gap under toolbar (8)
      const targetCssHeight = Math.max(160, Math.floor(vpH - toolbarH - margins));
      ui.wrap.style.height = targetCssHeight + 'px';
      ui.canvas.style.height = '92%';
      ui.canvas.style.width = '100%';
      const r = fitCanvasToDisplay(ui.canvas);
      if (waterfall) waterfall.setSize(r.w, r.h);
    }

    // Create waterfall and engine, then size the canvas and install axis provider
    const waterfall = new Waterfall(ui.canvas, {
      contrast: 1.0,
      luminosity: 0.0,
      logFreq: false,
    });
    const engine = new AudioEngine((mags) => waterfall.drawRow(mags));
    function installAxisProvider() {
      waterfall.setAxisContextProvider(() => ({
        sampleRate: engine.audio ? engine.audio.sampleRate : 48000,
        fftSize: engine.fftSize,
        decimation: engine.decimation,
        startedAt: engine._startedAt || 0,
        now: engine.audio ? engine.audio.currentTime : 0,
      }));
    }

    // Initial layout sizing and provider
    sizeCanvasToViewport();
    installAxisProvider();

    // Init controls from settings
    ui.fftSize.value = String(settings.fftSize);
    ui.decimation.value = String(settings.decimation);
    ui.dynRange.value = String(settings.dynRange);
    ui.contrast.value = String(settings.contrast);
    ui.luminosity.value = String(settings.luminosity);
    ui.sensitivity.value = String(settings.sensitivity);
    ui.logFreq.checked = !!settings.logFreqScale;

    engine.setFFTSize(parseInt(ui.fftSize.value, 10));
    // Reflect capped/adjusted fft size in the UI
    ui.fftSize.value = String(engine.fftSize);
    engine.setDecimation(parseInt(ui.decimation.value, 10));
    engine.setDynRange(parseInt(ui.dynRange.value, 10));
    engine.setSensitivity(parseFloat(ui.sensitivity.value));

    waterfall.opts.contrast = parseFloat(ui.contrast.value);
    waterfall.opts.luminosity = parseFloat(ui.luminosity.value);
    waterfall.opts.logFreq = !!ui.logFreq.checked;

    function persist() {
      saveSettings(Object.assign({}, engine.settings, {
        deviceId: ui.deviceSelect.value,
        contrast: parseFloat(ui.contrast.value),
        luminosity: parseFloat(ui.luminosity.value),
        sensitivity: parseFloat(ui.sensitivity.value),
        logFreqScale: !!ui.logFreq.checked,
      }));
    }

    ui.fftSize.addEventListener('change', () => {
      engine.setFFTSize(parseInt(ui.fftSize.value, 10));
      persist();
    });
    ui.decimation.addEventListener('change', () => {
      engine.setDecimation(parseInt(ui.decimation.value, 10));
      persist();
    });
    ui.dynRange.addEventListener('change', () => {
      engine.setDynRange(parseInt(ui.dynRange.value, 10));
      persist();
    });
    ui.contrast.addEventListener('input', () => {
      waterfall.opts.contrast = parseFloat(ui.contrast.value);
      persist();
    });
    ui.luminosity.addEventListener('input', () => {
      waterfall.opts.luminosity = parseFloat(ui.luminosity.value);
      persist();
    });
    ui.sensitivity.addEventListener('input', () => {
      engine.setSensitivity(parseFloat(ui.sensitivity.value));
      persist();
    });
    ui.logFreq.addEventListener('change', () => {
      waterfall.opts.logFreq = !!ui.logFreq.checked;
      persist();
    });

    window.addEventListener('resize', () => {
      sizeCanvasToViewport();
    });

    ui.startBtn.addEventListener('click', async () => {
      try {
        ui.startBtn.disabled = true;
        await engine.start(ui.deviceSelect.value);
        engine.setHidden(document.hidden);
        ui.stopBtn.disabled = false;
        ui.status.textContent = 'Running';
        persist();
      } catch (e) {
        console.error(e);
        const name = e && (e.name || e.constructor && e.constructor.name) || '';
        let help = '';
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError') {
          help = 'Microphone permission was not granted. Click Start to try again after allowing access in your browser.';
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          help = 'No microphone was found or the selected device is unavailable. Choose a different input and click Start again.';
        } else if (name === 'NotReadableError') {
          help = 'The microphone is in use by another application. Close other apps that use the mic and click Start to retry.';
        } else {
          help = 'An error occurred. Click Start to retry.';
        }
        ui.status.textContent = `Error: ${e.message || name}. ${help}`;
        ui.startBtn.disabled = false; // re-enable Start for retry
      }
      // After permission, repopulate devices to get labels
      populateDevices(ui.deviceSelect.value);
    });

    document.addEventListener('visibilitychange', () => {
      if (engine) {
        engine.setHidden(document.hidden);
        if (!document.hidden && engine.audio && engine.audio.state !== 'running') {
          engine.audio.resume().catch(()=>{});
        }
      }
    });

    ui.stopBtn.addEventListener('click', () => {
      engine.stop();
      ui.startBtn.disabled = false;
      ui.stopBtn.disabled = true;
      ui.status.textContent = 'Stopped';
    });

    populateDevices(settings.deviceId);
  }

  // Only run if page visible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
})();
