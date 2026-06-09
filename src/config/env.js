const fs = require("fs");
const path = require("path");
let dotenv = null;
try {
  dotenv = require("dotenv");
} catch (_) {
  dotenv = null;
}

const ROOT = path.resolve(__dirname, "..", "..");

for (const file of ["config/local.env", ".env.local", ".env"]) {
  const envPath = path.join(ROOT, file);
  if (dotenv && fs.existsSync(envPath)) dotenv.config({ path: envPath });
}

function loadJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function getAppMode() {
  return String(process.env.APP_MODE || process.env.NODE_ENV || "local").toLowerCase();
}

function loadAudioConfig() {
  const mode = getAppMode();
  const file = mode === "render" || mode === "production"
    ? "config/audio.render.json"
    : "config/audio.local.json";
  return loadJson(file);
}

function requireEnv(keys) {
  const missing = keys.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error("Missing required env: " + missing.join(", "));
  }
}

const env = {
  rootDir: ROOT,
  tmpDir: path.join(ROOT, "tmp"),
  appMode: getAppMode(),
  port: Number(process.env.PORT || 3000),
  sttProvider: String(process.env.STT_PROVIDER || "deepgram").toLowerCase(),
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  deepgramModel: process.env.DEEPGRAM_MODEL || "nova-3",
  deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || "vi",
  protocolVersion: process.env.PROTOCOL_VERSION || "2",
};

module.exports = {
  ROOT,
  env,
  loadJson,
  loadAudioConfig,
  requireEnv,
};
