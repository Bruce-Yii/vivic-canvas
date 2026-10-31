// Native Web Audio capture only. No audio is rendered to an output device.
class VivicPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packet = new Float32Array(2048);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === "stop") {
        this.stopped = true;
        if (this.used) this.port.postMessage(this.packet.slice(0, this.used));
        this.port.postMessage({ stopped: true });
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input) for (const value of input) {
      this.packet[this.used++] = value;
      if (this.used === this.packet.length) {
        this.port.postMessage(this.packet);
        this.packet = new Float32Array(2048);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("vivic-pcm-capture", VivicPcmCapture);
