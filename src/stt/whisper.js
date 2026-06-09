const path = require("path");
const { spawn } = require("child_process");
const { normalizeTranscript } = require("../utils/text");

class WhisperWorkerClient {
  constructor({ rootDir, timeoutMs, logger }) {
    this.rootDir = rootDir;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.worker = null;
    this.buffer = "";
    this.reqId = 0;
    this.pending = new Map();
  }

  preload() {
    this.start();
  }

  start() {
    if (this.worker && !this.worker.killed) return this.worker;
    const pyCmd = process.env.PYTHON_CMD || "py";
    const workerPath = path.join(this.rootDir, "python", "whisper_worker.py");
    this.buffer = "";
    this.worker = spawn(pyCmd, [workerPath], { cwd: this.rootDir, stdio: ["pipe", "pipe", "pipe"] });

    this.worker.stdout.on("data", chunk => this.onStdout(chunk));
    this.worker.stderr.on("data", chunk => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.info(text);
    });
    this.worker.on("close", code => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Whisper worker closed: " + code));
      }
      this.pending.clear();
      this.worker = null;
    });
    this.worker.on("error", err => {
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    return this.worker;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        this.logger.info(line);
        continue;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve({ transcript: normalizeTranscript(msg.text), confidence: Number(msg.confidence || 0) });
    }
  }

  transcribe(audioPath, options = {}) {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      const id = String(++this.reqId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Whisper timeout"));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      worker.stdin.write(JSON.stringify({
        id,
        audioPath,
        realtime: !!options.realtime,
      }) + "\n");
    });
  }
}

module.exports = { WhisperWorkerClient };
