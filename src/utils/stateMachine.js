const STATES = {
  BOOT: "BOOT",
  WIFI: "WIFI",
  WS: "WS",
  READY: "READY",
  WAKE: "WAKE",
  CAPTURE: "CAPTURE",
  PROCESS: "PROCESS",
  EXECUTE: "EXECUTE",
};

class StateMachine {
  constructor({ logger }) {
    this.logger = logger;
    this.state = STATES.BOOT;
    this.updatedAt = Date.now();
  }

  set(next, reason = "") {
    if (this.state === next) return;
    this.logger.debug(`${this.state} -> ${next}${reason ? ` (${reason})` : ""}`);
    this.state = next;
    this.updatedAt = Date.now();
  }

  get() {
    return this.state;
  }

  voiceState() {
    if (this.state === STATES.CAPTURE) return "capturing";
    if (this.state === STATES.PROCESS) return "processing";
    if (this.state === STATES.EXECUTE) return "executing";
    return "idle";
  }
}

module.exports = { StateMachine, STATES };
