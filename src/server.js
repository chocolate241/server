const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const wav = require("wav");
const { WebSocketServer } = require("ws");

const { env, loadAudioConfig } = require("./config/env");
const { createLogger } = require("./utils/logger");
const { shortText } = require("./utils/text");
const { StateMachine, STATES } = require("./utils/stateMachine");
const { DeviceManager } = require("./device/deviceManager");
const { createLocalParser } = require("./parser/localParser");
const { GeminiParser } = require("./parser/geminiParser");
const { CommandMemory } = require("./memory/memory");
const { CommandExecutor } = require("./executor/commandExecutor");
const { VoiceVad, calcRmsBuffer } = require("./vad/vad");
const { DeepgramClient } = require("./stt/deepgram");
const { WhisperWorkerClient } = require("./stt/whisper");
const { SttService } = require("./stt/sttService");
const { writePcmToWav, ensureDir } = require("./stt/audio");
const { BrowserHub } = require("./ws/browser");
const { Esp32Socket } = require("./ws/esp32");

const audioConfig = loadAudioConfig();
const logger = {
  system: createLogger("SYSTEM"),
  ws: createLogger("WS"),
  esp32: createLogger("ESP32"),
  vad: createLogger("VAD"),
  stt: createLogger("STT"),
  ai: createLogger("AI"),
  cmd: createLogger("CMD"),
  queue: createLogger("QUEUE"),
  memory: createLogger("MEMORY"),
  error: createLogger("ERROR"),
};

fs.mkdirSync(env.tmpDir, { recursive: true });

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const stateMachine = new StateMachine({ logger: logger.system });
const deviceManager = new DeviceManager();
const localParser = createLocalParser(deviceManager);
const memory = new CommandMemory({ localParser, logger: logger.memory });
const geminiParser = new GeminiParser({ deviceManager, env, logger: logger.ai, localParser });
const vad = new VoiceVad({ config: audioConfig.vad, audioConfig: audioConfig.audio, logger: logger.vad });
const esp32Socket = new Esp32Socket({ logger: logger.esp32, protocolConfig: audioConfig.protocol });

let browserHub;
let commandExecutor;
let currentTranscript = "";
let recording = false;
let recordWriter = null;
let latestRecordPath = "";

function getStatus() {
  return {
    recording,
    esp32Connected: esp32Socket.isConnected(),
    voiceState: stateMachine.voiceState(),
    state: stateMachine.get(),
    transcript: currentTranscript,
    lights: commandExecutor ? commandExecutor.getLightState() : deviceManager.getInitialState(),
    memorySize: memory.size(),
  };
}

browserHub = new BrowserHub({
  deviceManager,
  logger: createLogger("BROWSER"),
  getStatus,
  onDirectCommand: async command => {
    await commandExecutor.enqueue([command]);
    browserHub.broadcastStatus();
  },
});

commandExecutor = new CommandExecutor({
  deviceManager,
  esp32Socket,
  browserHub,
  config: audioConfig.queue,
  logger: logger.queue,
});

const deepgramClient = new DeepgramClient({ env, logger: logger.stt });
const whisperClient = new WhisperWorkerClient({
  rootDir: env.rootDir,
  timeoutMs: audioConfig.stt.whisperTimeoutMs,
  logger: createLogger("WHISPER"),
});
const sttService = new SttService({
  env,
  config: audioConfig.stt,
  tmpDir: env.tmpDir,
  logger: logger.stt,
  localParser,
  whisperClient,
  deepgramClient,
  calcRmsBuffer,
});

function setState(next, reason = "") {
  stateMachine.set(next, reason);
  browserHub.broadcastStatus();
}

function notifyNotClear(reason) {
  logger.cmd.info("no valid command: " + reason);
  browserHub.broadcastLog(`Khong thuc hien duoc lenh: ${reason}${currentTranscript ? `\nSTT: ${currentTranscript}` : ""}`);
  esp32Socket.sendControl("not_clear", { reason });
}

function rearmWake() {
  setState(STATES.READY, "rearm");
  esp32Socket.sendControl("rearm_wake");
  logger.system.info("ready for next wake word");
}

function startVoiceCapture() {
  if (stateMachine.get() === STATES.PROCESS || stateMachine.get() === STATES.EXECUTE) {
    esp32Socket.sendControl("stop_capture");
    return;
  }
  setState(STATES.CAPTURE, "wake");
  vad.start();
  currentTranscript = "";
  browserHub.broadcastTranscript("Listening...");
  logger.vad.info(`capture start, grace=${audioConfig.vad.startGraceMs}ms, silence=${audioConfig.vad.silenceFrames}, threshold=${audioConfig.vad.silenceRmsThreshold}`);
}

function stopRecording() {
  const wasRecording = recording;
  recording = false;
  if (recordWriter) {
    recordWriter.end();
    recordWriter = null;
  }
  browserHub.broadcastStatus();
  return wasRecording;
}

async function startRecording() {
  await ensureDir(env.tmpDir);
  if (latestRecordPath) fs.promises.unlink(latestRecordPath).catch(() => {});
  latestRecordPath = path.join(env.tmpDir, `record_${Date.now()}.wav`);
  recordWriter = new wav.FileWriter(latestRecordPath, {
    sampleRate: audioConfig.audio.sampleRate,
    channels: audioConfig.audio.channels,
    bitDepth: audioConfig.audio.bitDepth,
  });
  recording = true;
  browserHub.broadcastStatus();
}

async function handleAudioChunk(buffer) {
  if (recording && recordWriter) {
    recordWriter.write(buffer);
  }

  if (!recording) {
    browserHub.broadcastBinary(buffer);
  }

  if (stateMachine.get() !== STATES.CAPTURE) {
    return;
  }

  const endReason = vad.process(buffer);
  if (endReason) {
    await finishVoiceCapture(endReason);
  }
}

async function finishVoiceCapture(reason) {
  if (stateMachine.get() !== STATES.CAPTURE) return;
  setState(STATES.PROCESS, reason);
  esp32Socket.sendControl("stop_capture", { reason });

  const capture = vad.stop();
  logger.vad.info(`capture end reason=${reason}, size=${(capture.bytes / 1024).toFixed(1)}KB, time=${(capture.durationMs / 1000).toFixed(1)}s`);

  if (!capture.chunks.length || capture.bytes < vad.minVoiceBytes()) {
    browserHub.broadcastTranscript("");
    notifyNotClear("audio_too_short");
    rearmWake();
    return;
  }

  let transcript = "";
  try {
    transcript = await sttService.transcribe(capture.chunks, audioConfig.audio);
  } catch (err) {
    logger.stt.error(err.message);
    notifyNotClear("stt_error");
    rearmWake();
    return;
  }

  currentTranscript = transcript;
  browserHub.broadcastTranscript(transcript);
  logger.stt.info(transcript ? shortText(transcript) : "empty transcript");

  if (!transcript) {
    notifyNotClear("stt_empty");
    rearmWake();
    return;
  }

  const started = Date.now();
  let result;
  try {
    result = await resolveCommand(transcript);
  } catch (err) {
    logger.error.error(err.message);
    notifyNotClear("parse_error");
    rearmWake();
    return;
  }

  const commands = result.commands || [];
  logger.cmd.info(`${commands.length ? commands.join(", ") : "no command"} (${result.source}, ${Date.now() - started}ms)`);

  if (!commands.length) {
    notifyNotClear(`no_valid_command source=${result.source}`);
    rearmWake();
    return;
  }

  setState(STATES.EXECUTE, "command");
  let executeResults = [];
  try {
    executeResults = await commandExecutor.enqueue(commands);
  } catch (err) {
    logger.queue.error(err.message);
    notifyNotClear("execute_error");
    rearmWake();
    return;
  }

  const failed = executeResults.filter(result => result && result.success === false);
  if (failed.length) {
    notifyNotClear("execute_failed");
  }

  browserHub.broadcastLog(
    `STT: ${transcript}\n` +
    `Source: ${result.source}\n` +
    `Commands: ${JSON.stringify(commands)}`
  );
  rearmWake();
}

async function resolveCommand(text) {
  if (!localParser.isLikelySmartHomeCommand(text)) {
    return { source: "guard", commands: [], confidence: 0 };
  }

  const local = localParser.parse(text);
  if (local?.commands?.length) {
    memory.saveCandidate(text, local.commands, local.confidence, true).catch(err => logger.memory.warn(err.message));
    return local;
  }

  if (!localParser.shouldBypassMemory(text)) {
    const cached = memory.getVerified(text);
    if (cached) return cached;
  }

  const gemini = await geminiParser.parse(text);
  if (gemini.commands?.length) {
    memory.saveCandidate(text, gemini.commands, gemini.confidence, false).catch(err => logger.memory.warn(err.message));
  }
  return gemini;
}

esp32Socket.onWake = () => {
  logger.esp32.info("wake detected");
  startVoiceCapture();
};
esp32Socket.onStop = reason => finishVoiceCapture(reason).catch(err => logger.error.error(err.message));
esp32Socket.onAudio = buffer => handleAudioChunk(buffer).catch(err => logger.error.error(err.message));
esp32Socket.onReady = () => {
  if (stateMachine.get() === STATES.BOOT || stateMachine.get() === STATES.WS) {
    setState(STATES.READY, "esp32 ready");
  }
  logger.esp32.info("wake ready");
};
esp32Socket.onDisconnect = () => {
  vad.reset();
  setState(STATES.WS, "esp32 disconnected");
};

wss.on("connection", (ws, req) => {
  if (req.url.includes("client=browser")) {
    browserHub.handleConnection(ws);
    return;
  }
  setState(STATES.WS, "esp32 connected");
  esp32Socket.handleConnection(ws);
});

app.get("/", (req, res) => res.send(browserHub.renderHome()));

app.post("/record/toggle", async (req, res) => {
  if (!recording) {
    await startRecording();
    return res.json({ ok: true, recording: true });
  }
  stopRecording();
  return res.json({ ok: true, recording: false });
});

app.get("/latest-record.wav", (req, res) => {
  if (!latestRecordPath || !fs.existsSync(latestRecordPath)) return res.status(404).send("No file");
  res.sendFile(latestRecordPath);
});

app.post("/chat", async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, message: "Missing text" });
  try {
    const started = Date.now();
    const result = await resolveCommand(text);
    const commands = result.commands || [];
    if (!commands.length) {
      notifyNotClear(`manual_no_valid_command source=${result.source}`);
    }
    let executeResults = [];
    if (commands.length) {
      executeResults = await commandExecutor.enqueue(commands);
      if (executeResults.some(item => item && item.success === false)) {
        notifyNotClear("manual_execute_failed");
      }
    }
    res.json({
      ok: true,
      source: result.source,
      commands,
      duration: Date.now() - started,
      message: esp32Socket.isConnected() ? "Sent OK" : "ESP32 is not connected",
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/memory", (req, res) => res.json(memory.toJSON()));

app.post("/memory/clear", async (req, res) => {
  try {
    await memory.clear();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/health", async (req, res) => {
  res.json({
    server: true,
    mode: env.appMode,
    sttProvider: env.sttProvider,
    supabase: await memory.health(),
    memorySize: memory.size(),
    esp32: esp32Socket.isConnected(),
    state: stateMachine.get(),
  });
});

async function start() {
  stateMachine.set(STATES.BOOT, "start");
  if ((env.appMode === "render" || env.appMode === "production") && env.sttProvider === "whisper") {
    logger.system.warn("Render/production should use STT_PROVIDER=deepgram; Whisper local is slow on cloud CPU");
  }
  await memory.load();
  server.listen(env.port, () => {
    stateMachine.set(STATES.WS, "server listening");
    logger.system.info(`server listening on http://localhost:${env.port} mode=${env.appMode} stt=${env.sttProvider}`);
    sttService.preload().catch(err => logger.stt.warn("preload failed: " + err.message));
  });
}

start().catch(err => {
  logger.error.error(err.stack || err.message);
  process.exit(1);
});
