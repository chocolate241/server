function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CommandExecutor {
  constructor({ deviceManager, esp32Socket, browserHub, config, logger }) {
    this.deviceManager = deviceManager;
    this.esp32 = esp32Socket;
    this.browserHub = browserHub;
    this.config = config;
    this.logger = logger;
    this.queue = [];
    this.running = false;
    this.pendingAck = new Map();
    this.lightState = deviceManager.getInitialState();

    this.esp32.onAck = ack => this.handleAck(ack);
  }

  getLightState() {
    return this.lightState;
  }

  enqueue(commands) {
    return new Promise((resolve, reject) => {
      this.queue.push({ commands, resolve, reject });
      this.run().catch(reject);
    });
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          const result = await this.execute(job.commands);
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async execute(commands) {
    const results = [];
    for (const command of commands) {
      if (/^DELAY:\d+$/.test(command)) {
        await sleep(Number(command.split(":")[1]));
        continue;
      }

      const parsed = this.deviceManager.parseCommand(command);
      if (!parsed) {
        results.push({ command, success: false, error: "invalid command" });
        continue;
      }

      const result = await this.executeDirect(parsed);
      results.push(result);
      await sleep(this.config.betweenCommandsMs);
    }
    return results;
  }

  async executeDirect(parsed) {
    if (!this.esp32.isConnected()) {
      throw new Error("ESP32 is not connected");
    }

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        this.logger.info(`send ${parsed.command}${attempt ? ` retry=${attempt}` : ""}`);
        const ackPromise = this.waitAck(parsed.command);
        this.esp32.sendCommand(parsed);
        const ack = await ackPromise;
        if (ack.success) {
          this.lightState[parsed.device] = !!ack.state;
          this.browserHub.broadcastStatus();
        }
        return ack;
      } catch (err) {
        if (attempt >= this.config.retries) {
          this.logger.warn(`ack timeout ${parsed.command}`);
          return { command: parsed.command, success: false, error: err.message };
        }
      }
    }
  }

  waitAck(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck.delete(command);
        reject(new Error("ACK timeout"));
      }, this.config.ackTimeoutMs);
      this.pendingAck.set(command, { resolve, reject, timer });
    });
  }

  handleAck(ack) {
    if (!ack?.command && ack?.device) {
      ack.command = `${ack.device}_${ack.state ? "ON" : "OFF"}`;
    }
    if (!ack?.command) return;

    const pending = this.pendingAck.get(ack.command);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAck.delete(ack.command);
      pending.resolve({
        command: ack.command,
        device: ack.device,
        state: !!ack.state,
        success: ack.success !== false,
      });
      return;
    }

    const parsed = this.deviceManager.parseCommand(ack.command);
    if (parsed && ack.success !== false) {
      this.lightState[parsed.device] = ack.state == null ? parsed.state : !!ack.state;
      this.browserHub.broadcastStatus();
    }
  }
}

module.exports = { CommandExecutor };
