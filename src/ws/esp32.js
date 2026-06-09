class Esp32Socket {
  constructor({ logger, protocolConfig }) {
    this.logger = logger;
    this.protocolConfig = protocolConfig;
    this.ws = null;
    this.deviceId = "";
    this.protocol = "1";
    this.onWake = null;
    this.onStop = null;
    this.onAudio = null;
    this.onReady = null;
    this.onDisconnect = null;
    this.onAck = null;
  }

  handleConnection(ws) {
    this.ws = ws;
    this.protocol = "1";
    this.deviceId = "legacy-esp32";
    this.logger.info("ESP32 connected");

    ws.on("message", (message, isBinary) => {
      if (isBinary) {
        if (this.onAudio) this.onAudio(message);
        return;
      }
      this.handleText(message.toString().trim());
    });

    ws.on("close", () => {
      this.logger.warn("ESP32 disconnected");
      this.ws = null;
      if (this.onDisconnect) this.onDisconnect();
    });
  }

  handleText(text) {
    if (!text) return;

    const json = this.parseJson(text);
    if (json) {
      this.handleJson(json);
      return;
    }

    if (text === "ESP32_READY") {
      this.send({ type: "server_ready", protocol: this.protocolConfig.version });
      if (this.onReady) this.onReady();
      return;
    }
    if (text === "WAKE_READY") {
      if (this.onReady) this.onReady();
      return;
    }
    if (text === "MIC_LISTEN_START") {
      if (this.onWake) this.onWake({ legacy: true });
      return;
    }
    if (text === "MIC_LISTEN_STOP") {
      if (this.onStop) this.onStop("esp32_timeout");
      return;
    }

    const ack = this.parseLegacyAck(text);
    if (ack) {
      if (this.onAck) this.onAck(ack);
      return;
    }

    this.logger.info(text);
  }

  parseJson(text) {
    if (!text.startsWith("{")) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  handleJson(message) {
    const type = String(message.type || "").toLowerCase();
    if (type === "hello") {
      this.deviceId = message.device || message.deviceId || "esp32";
      this.protocol = String(message.protocol || "1");
      if (!this.protocolConfig.compatibleVersions.includes(this.protocol)) {
        this.logger.warn(`unsupported protocol ${this.protocol} from ${this.deviceId}`);
        this.send({ type: "error", reason: "unsupported_protocol", protocol: this.protocolConfig.version });
        return;
      }
      this.logger.info(`hello device=${this.deviceId} protocol=${this.protocol}`);
      this.send({ type: "server_ready", protocol: this.protocolConfig.version });
      if (this.onReady) this.onReady();
      return;
    }

    if (type === "wake_detected" || type === "mic_listen_start") {
      if (this.onWake) this.onWake(message);
      return;
    }

    if (type === "audio_end" || type === "mic_listen_stop") {
      if (this.onStop) this.onStop(message.reason || "esp32_timeout");
      return;
    }

    if (type === "wake_ready") {
      if (this.onReady) this.onReady();
      return;
    }

    if (type === "ack") {
      if (this.onAck) this.onAck({
        command: message.command,
        device: message.device,
        state: message.state,
        success: message.success !== false,
      });
      return;
    }

    this.logger.debug("json message " + JSON.stringify(message));
  }

  parseLegacyAck(text) {
    const match = text.match(/^OK\s+([A-Z0-9]+)_(ON|OFF)$/);
    if (!match) return null;
    return {
      command: `${match[1]}_${match[2]}`,
      device: match[1],
      state: match[2] === "ON",
      success: true,
    };
  }

  isConnected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  send(payload) {
    if (!this.isConnected()) return false;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.ws.send(text);
    return true;
  }

  sendControl(type, extra = {}) {
    if (this.protocol === "2") {
      return this.send({ type, ...extra });
    }
    const legacy = {
      stop_capture: "VOICE_STOP_CAPTURE",
      rearm_wake: "WAKE_REARM",
      not_clear: "VOICE_NOT_CLEAR",
    }[type] || type;
    return this.send(legacy);
  }

  sendCommand(parsed) {
    if (this.protocol === "2") {
      return this.send({
        type: "command",
        command: parsed.command,
        device: parsed.device,
        gpio: parsed.gpio,
        state: parsed.state,
      });
    }
    return this.send(parsed.command);
  }
}

module.exports = { Esp32Socket };
