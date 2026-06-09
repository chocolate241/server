function calcRmsBuffer(buffer) {
  const samples = buffer.length / 2;
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

class VoiceVad {
  constructor({ config, audioConfig, logger }) {
    this.config = config;
    this.audioConfig = audioConfig;
    this.logger = logger;
    this.reset();
  }

  reset() {
    this.active = false;
    this.chunks = [];
    this.bytes = 0;
    this.silence = 0;
    this.noiseFloor = 0;
    this.startedAt = 0;
    this.lastLogAt = 0;
  }

  start() {
    this.reset();
    this.active = true;
    this.startedAt = Date.now();
  }

  stop() {
    const result = {
      chunks: this.chunks,
      bytes: this.bytes,
      durationMs: Date.now() - this.startedAt,
    };
    this.reset();
    return result;
  }

  minVoiceBytes() {
    return Math.floor(this.audioConfig.sampleRate * 2 * this.config.minVoiceMs / 1000);
  }

  updateNoiseFloor(rms) {
    if (!this.config.adaptiveEnabled || !rms) return;
    if (!this.noiseFloor) {
      this.noiseFloor = rms;
      return;
    }
    const alpha = rms < this.noiseFloor ? 0.35 : 0.03;
    this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;
  }

  threshold() {
    if (!this.config.adaptiveEnabled || !this.noiseFloor) {
      return this.config.silenceRmsThreshold;
    }
    const adaptive = this.noiseFloor * this.config.noiseMultiplier + this.config.noiseMargin;
    return Math.max(this.config.silenceRmsThreshold, adaptive);
  }

  process(buffer) {
    if (!this.active) return null;

    const copy = Buffer.from(buffer);
    this.chunks.push(copy);
    this.bytes += copy.length;

    const rms = calcRmsBuffer(buffer);
    const now = Date.now();
    const ageMs = now - this.startedAt;
    this.updateNoiseFloor(rms);
    const threshold = this.threshold();

    if (this.config.debugLog && now - this.lastLogAt >= this.config.logMs) {
      this.logger.debug(`rms=${rms.toFixed(0)}, threshold=${threshold.toFixed(0)}, noise=${this.noiseFloor.toFixed(0)}, silence=${this.silence}/${this.config.silenceFrames}, time=${(ageMs / 1000).toFixed(1)}s`);
      this.lastLogAt = now;
    }

    if (ageMs >= this.config.captureSafetyMs && this.bytes > this.minVoiceBytes()) {
      return "safety_timeout";
    }

    if (ageMs < this.config.startGraceMs) {
      this.silence = 0;
      return null;
    }

    if (rms < threshold) {
      this.silence += 1;
      if (this.silence >= this.config.silenceFrames && this.bytes > this.minVoiceBytes()) {
        return "vad";
      }
    } else {
      this.silence = 0;
    }

    return null;
  }
}

module.exports = { VoiceVad, calcRmsBuffer };
