/** Stateful 65-tap polyphase low-pass resampler. Keeps fractional phase and history across packets. */
export class StreamingPcmResampler {
  readonly sourceRate: number;
  private readonly half = 32;
  private readonly phases = 1024;
  private weights: Float32Array[] = [];
  private history = new Float32Array(0);
  private base = 0;
  private received = 0;
  private outputFrames = 0;
  private ended = false;
  constructor(sourceRate: number) {
    if (!Number.isInteger(sourceRate) || sourceRate < 8000 || sourceRate > 192000) throw new Error("不支持此设备采样率。");
    this.sourceRate = sourceRate;
    if (sourceRate === 16000) return;
    const cutoff = 0.45 * Math.min(1, 16000 / sourceRate);
    for (let phase = 0; phase < this.phases; phase++) {
      const coefficients = new Float32Array(this.half * 2 + 1), fraction = phase / this.phases;
      let sum = 0;
      for (let tap = -this.half; tap <= this.half; tap++) {
        const at = tap - fraction;
        const sinc = at === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * at) / (Math.PI * at);
        const window = 0.42 + 0.5 * Math.cos(Math.PI * at / (this.half + 1)) + 0.08 * Math.cos(2 * Math.PI * at / (this.half + 1));
        coefficients[tap + this.half] = sinc * window;
        sum += coefficients[tap + this.half]!;
      }
      for (let tap = 0; tap < coefficients.length; tap++) coefficients[tap] = coefficients[tap]! / sum;
      this.weights.push(coefficients);
    }
  }
  push(samples: Float32Array): Float32Array {
    if (this.ended) throw new Error("重采样器已结束。");
    if (!(samples instanceof Float32Array) || samples.length > this.sourceRate) throw new Error("音频分块过大。");
    for (const value of samples) if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("音频采样无效。");
    if (this.sourceRate === 16000) { this.received += samples.length; this.outputFrames += samples.length; return new Float32Array(samples); }
    const joined = new Float32Array(this.history.length + samples.length); joined.set(this.history); joined.set(samples, this.history.length);
    this.history = joined; this.received += samples.length;
    return this.drain(false);
  }
  private drain(final: boolean) {
    const output: number[] = [];
    while (true) {
      // Derive position from the integer output count: no packet-boundary phase reset/drift.
      const position = this.outputFrames * this.sourceRate / 16000, center = Math.floor(position);
      if (final ? position >= this.received : center + this.half >= this.received) break;
      const coefficients = this.weights[Math.min(this.phases - 1, Math.floor((position - center) * this.phases))]!;
      let value = 0;
      for (let tap = -this.half; tap <= this.half; tap++) {
        const index = center + tap;
        if (index >= this.base && index < this.received) value += this.history[index - this.base]! * coefficients[tap + this.half]!;
      }
      output.push(Math.max(-1, Math.min(1, value))); this.outputFrames++;
    }
    const keepFrom = Math.min(this.received, Math.max(this.base, Math.floor(this.outputFrames * this.sourceRate / 16000) - this.half));
    this.history = this.history.slice(keepFrom - this.base); this.base = keepFrom;
    return new Float32Array(output);
  }
  /** Zero-padded FIR tail, preserving the exact duration rather than appending extra audio. */
  flush(): Float32Array {
    if (this.ended) return new Float32Array(0);
    this.ended = true;
    const output = this.sourceRate === 16000 ? new Float32Array(0) : this.drain(true);
    this.history = new Float32Array(0); return output;
  }
}
