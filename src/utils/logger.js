const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(scope, options = {}) {
  const configured = String(options.level || process.env.LOG_LEVEL || "info").toLowerCase();
  const minLevel = LEVELS[configured] || LEVELS.info;

  function write(level, message, meta) {
    if ((LEVELS[level] || LEVELS.info) < minLevel) return;
    const time = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    const safeMessage = String(message || "").replace(/(api[_-]?key|service[_-]?role|token|password)=\S+/ig, "$1=[hidden]");
    const suffix = meta ? " " + JSON.stringify(meta) : "";
    console.log(`${time} [${scope}] ${level.toUpperCase()}: ${safeMessage}${suffix}`);
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

module.exports = { createLogger };
