const fs = require("fs");
const path = require("path");
const wav = require("wav");

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function writePcmToWav(chunks, filePath, audioConfig) {
  return new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(filePath, {
      sampleRate: audioConfig.sampleRate,
      channels: audioConfig.channels,
      bitDepth: audioConfig.bitDepth,
    });
    writer.on("error", reject);
    writer.on("finish", resolve);
    for (const chunk of chunks) writer.write(chunk);
    writer.end();
  });
}

function calcPcm16Stats(buffer) {
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const value = buffer.readInt16LE(i);
    const abs = Math.abs(value);
    sum += value * value;
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sum / samples), peak };
}

function preprocessPcm16Chunks(chunks, config, logger) {
  if (!config.preprocessEnabled) return chunks;
  const input = Buffer.concat(chunks);
  const before = calcPcm16Stats(input);
  if (!before.rms || !before.peak) return chunks;

  const sampleCount = Math.floor(input.length / 2);
  const filtered = new Float32Array(sampleCount);
  let prevIn = 0;
  let prevOut = 0;

  for (let i = 0; i < sampleCount; i++) {
    const sample = input.readInt16LE(i * 2);
    const highpass = config.highpassAlpha * (prevOut + sample - prevIn);
    filtered[i] = highpass;
    prevIn = sample;
    prevOut = highpass;
  }

  let sum = 0;
  let peak = 0;
  for (const sample of filtered) {
    const abs = Math.abs(sample);
    sum += sample * sample;
    if (abs > peak) peak = abs;
  }
  if (!peak) return chunks;

  const rms = Math.sqrt(sum / sampleCount);
  const gain = Math.max(0.2, Math.min(config.maxGain, config.targetRms / rms, config.targetPeak / peak));
  const output = Buffer.allocUnsafe(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    let sample = Math.round(filtered[i] * gain);
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    output.writeInt16LE(sample, i * 2);
  }

  if (config.debugLog) {
    const after = calcPcm16Stats(output);
    logger.debug(`preprocess rms ${before.rms.toFixed(0)} -> ${after.rms.toFixed(0)}, peak ${before.peak} -> ${after.peak}, gain=${gain.toFixed(2)}`);
  }
  return [output];
}

function slicePcm16Buffer(buffer, startByte, endByte) {
  const start = Math.max(0, Math.min(buffer.length, startByte - (startByte % 2)));
  const end = Math.max(start, Math.min(buffer.length, endByte - (endByte % 2)));
  return buffer.subarray(start, end);
}

function buildSttCandidates(chunks, audioConfig, sttConfig, calcRmsBuffer) {
  const full = Buffer.concat(chunks);
  const candidates = [{ name: "full", buffer: full }];
  if (!sttConfig.candidatesEnabled || full.length < audioConfig.sampleRate) return candidates;

  const frameBytes = Math.max(2, Math.floor(audioConfig.sampleRate * 2 * 100 / 1000));
  const padBytes = Math.floor(audioConfig.sampleRate * 2 * sttConfig.candidatePadMs / 1000);
  const windowBytes = Math.floor(audioConfig.sampleRate * 2 * sttConfig.candidateWindowMs / 1000);

  const frames = [];
  for (let offset = 0; offset + frameBytes <= full.length; offset += frameBytes) {
    const frame = full.subarray(offset, offset + frameBytes);
    frames.push({ offset, rms: calcRmsBuffer(frame) });
  }

  const active = frames.filter(frame => frame.rms >= sttConfig.candidateRmsThreshold);
  if (active.length) {
    const start = Math.max(0, active[0].offset - padBytes);
    const end = Math.min(full.length, active[active.length - 1].offset + frameBytes + padBytes);
    const trimmed = slicePcm16Buffer(full, start, end);
    if (trimmed.length >= Math.min(full.length, frameBytes * 3)) candidates.push({ name: "trimmed", buffer: trimmed });
  }

  const loudest = frames.reduce((best, frame) => frame.rms > best.rms ? frame : best, frames[0]);
  if (loudest) {
    const center = loudest.offset + Math.floor(frameBytes / 2);
    const winStart = Math.max(0, center - Math.floor(windowBytes / 2));
    const loud = slicePcm16Buffer(full, winStart, Math.min(full.length, winStart + windowBytes));
    if (loud.length >= Math.min(full.length, frameBytes * 3)) candidates.push({ name: "loudest", buffer: loud });
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.name}:${candidate.buffer.length}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

function tmpWavPath(tmpDir, prefix, name = "audio") {
  return path.join(tmpDir, `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}_${name}.wav`);
}

module.exports = {
  ensureDir,
  writePcmToWav,
  calcPcm16Stats,
  preprocessPcm16Chunks,
  buildSttCandidates,
  tmpWavPath,
};
