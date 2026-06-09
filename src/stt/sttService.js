const fs = require("fs");
const {
  ensureDir,
  writePcmToWav,
  preprocessPcm16Chunks,
  buildSttCandidates,
  tmpWavPath,
} = require("./audio");
const { cleanTranscript, correctSmartHomeTranscript } = require("../utils/text");

class SttService {
  constructor({ env, config, tmpDir, logger, localParser, whisperClient, deepgramClient, calcRmsBuffer }) {
    this.env = env;
    this.config = config;
    this.tmpDir = tmpDir;
    this.logger = logger;
    this.localParser = localParser;
    this.whisper = whisperClient;
    this.deepgram = deepgramClient;
    this.calcRmsBuffer = calcRmsBuffer;
  }

  async preload() {
    if (this.env.sttProvider !== "deepgram" && this.config.preloadWhisper) {
      this.logger.info("preload Whisper worker");
      this.whisper.preload();
    }
  }

  scoreTranscript(text) {
    const normalized = cleanTranscript(text, this.localParser.isLikelySmartHomeCommand);
    if (!normalized) return 0;
    let score = 1;
    const key = this.localParser.normalizeKey(normalized);
    if (this.localParser.isLikelySmartHomeCommand(normalized)) score += 40;
    if (this.localParser.parse(normalized)) score += 70;
    if (/\b(bat|tat|mo|dong|cac|cat)\b/.test(key)) score += 15;
    if (/\b(den|dien|phong|khach|ngu|bep|het|tat ca|toan bo)\b/.test(key)) score += 15;
    if (/\b(video|subscribe|thank|hello|xin chao)\b/.test(key)) score -= 40;
    return score;
  }

  async transcribeProvider(audioPath) {
    if (this.env.sttProvider === "deepgram") {
      return this.deepgram.transcribe(audioPath);
    }
    if (this.env.sttProvider === "whisper") {
      if (this.config.parallelProviders && process.env.DEEPGRAM_API_KEY) {
        return this.transcribeFirstNonEmpty(audioPath);
      }

      const result = await this.whisper.transcribe(audioPath, { realtime: false });
      if (result.transcript || !this.config.fallbackOnEmpty || !process.env.DEEPGRAM_API_KEY) {
        return result;
      }
      this.logger.warn("Whisper returned empty, fallback Deepgram");
      return this.deepgram.transcribe(audioPath);
    }

    try {
      const result = await this.whisper.transcribe(audioPath, { realtime: false });
      if (result.transcript || !this.config.fallbackOnEmpty) return result;
    } catch (err) {
      this.logger.warn("Whisper failed, fallback Deepgram: " + err.message);
    }

    if (process.env.DEEPGRAM_API_KEY) return this.deepgram.transcribe(audioPath);
    return { transcript: "", confidence: 0 };
  }

  transcribeFirstNonEmpty(audioPath) {
    return new Promise(resolve => {
      let pending = 2;
      let fallback = { transcript: "", confidence: 0, provider: "" };
      let settled = false;

      const done = (provider, result) => {
        if (settled) return;
        pending -= 1;
        const transcript = result?.transcript || "";
        if (transcript) {
          settled = true;
          this.logger.debug(`using ${provider} transcript first`);
          resolve({ ...result, provider });
          return;
        }
        fallback = { transcript: "", confidence: result?.confidence || 0, provider };
        if (pending <= 0) {
          settled = true;
          resolve(fallback);
        }
      };

      const fail = (provider, err) => {
        if (settled) return;
        this.logger.warn(`${provider} failed: ${err.message}`);
        done(provider, { transcript: "", confidence: 0 });
      };

      this.whisper.transcribe(audioPath, { realtime: false })
        .then(result => done("whisper", result))
        .catch(err => fail("whisper", err));

      this.deepgram.transcribe(audioPath)
        .then(result => done("deepgram", result))
        .catch(err => fail("deepgram", err));
    });
  }

  scheduleTmpDelete(file) {
    const delayMs = this.config.tmpDeleteDelayMs || 60000;
    setTimeout(() => {
      fs.promises.unlink(file).catch(() => {});
    }, delayMs).unref();
  }

  async transcribeBest(chunks) {
    await ensureDir(this.tmpDir);
    const sttChunks = preprocessPcm16Chunks(chunks, this.config, this.logger);
    const candidates = buildSttCandidates(sttChunks, this.audioConfig, this.config, this.calcRmsBuffer);
    const filesToDelete = [];
    let best = { transcript: "", confidence: 0, score: 0, path: "", source: "" };

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const audioPath = tmpWavPath(this.tmpDir, "stt", candidate.name);
      filesToDelete.push(audioPath);
      await writePcmToWav([candidate.buffer], audioPath, this.audioConfig);

      try {
        const result = await this.transcribeProvider(audioPath);
        const transcript = correctSmartHomeTranscript(cleanTranscript(result.transcript, this.localParser.isLikelySmartHomeCommand));
        const score = this.scoreTranscript(transcript);
        if (this.config.debugLog) {
          this.logger.debug(`candidate ${candidate.name}: "${transcript}", score=${score}`);
        }

        if (score > best.score || (!best.transcript && transcript)) {
          best = { transcript, confidence: result.confidence || 0, score, path: audioPath, source: candidate.name };
        }
        if (score >= this.config.candidateEarlyScore) break;
      } catch (err) {
        if (this.config.debugLog) this.logger.warn(`skip candidate ${candidate.name}: ${err.message}`);
      }
    }

    if (best.transcript) {
      best.transcript = await this.verifyWithDeepgram(best.path, best.transcript);
    }

    for (const file of filesToDelete) this.scheduleTmpDelete(file);

    return best.transcript || "";
  }

  async verifyWithDeepgram(audioPath, transcript) {
    if (!this.config.verifyDeepgramEnabled) return transcript;
    if (this.env.sttProvider === "deepgram") return transcript;
    if (!process.env.DEEPGRAM_API_KEY) return transcript;

    const parsed = this.localParser.parse(transcript);
    if (!parsed?.commands?.length) return transcript;

    const key = this.localParser.normalizeKey(transcript);
    const shouldVerify = this.config.verifyDeepgramScope === "all" ||
      this.localParser.isAllLightCommand(parsed.commands) ||
      /\b(het|tat ca|toan bo|moi den|den het)\b/.test(key);
    if (!shouldVerify) return transcript;

    try {
      const dg = await this.deepgram.transcribe(audioPath);
      if (dg.confidence < this.config.verifyDeepgramMinConfidence) return transcript;
      const verifiedTranscript = correctSmartHomeTranscript(cleanTranscript(dg.transcript, this.localParser.isLikelySmartHomeCommand));
      const verified = this.localParser.parse(verifiedTranscript);
      if (!verified?.commands?.length) return transcript;

      const currentPolarity = this.localParser.commandPolarity(parsed.commands);
      const verifiedPolarity = this.localParser.commandPolarity(verified.commands);
      if (currentPolarity && verifiedPolarity && currentPolarity !== verifiedPolarity) {
        this.logger.info(`verify Deepgram: "${transcript}" -> "${verifiedTranscript}"`);
        return verifiedTranscript;
      }
    } catch (err) {
      if (this.config.debugLog) this.logger.warn("Deepgram verify failed: " + err.message);
    }
    return transcript;
  }

  async transcribe(chunks, audioConfig) {
    this.audioConfig = audioConfig;
    return this.transcribeBest(chunks);
  }
}

module.exports = { SttService };
