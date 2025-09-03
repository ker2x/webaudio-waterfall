class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const chan = input[0]; // mono
      // Post a copy to avoid transfer issues
      this.port.postMessage(chan.slice(0));
    }
    // no outputs; keep node alive
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
