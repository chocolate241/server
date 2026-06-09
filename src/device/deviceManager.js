const { loadJson } = require("../config/env");
const { normalizeKey } = require("../utils/text");

class DeviceManager {
  constructor(config = loadJson("config/devices.json")) {
    this.devices = (config.devices || []).map(device => {
      const gpio = device.gpio || device.pin;
      return {
        ...device,
        gpio,
        alias: device.alias || device.aliases || [],
      };
    });
    this.byGpio = new Map(this.devices.map(device => [device.gpio, device]));
    this.validCommands = new Set(this.devices.flatMap(device => [`${device.gpio}_ON`, `${device.gpio}_OFF`]));
  }

  getDevices() {
    return this.devices;
  }

  getDevicePins() {
    return this.devices.map(device => device.gpio);
  }

  getInitialState() {
    return Object.fromEntries(this.devices.map(device => [device.gpio, false]));
  }

  getValidCommands() {
    return this.validCommands;
  }

  isValidCommand(command) {
    return this.validCommands.has(command);
  }

  parseCommand(command) {
    const match = String(command || "").match(/^([A-Z0-9]+)_(ON|OFF)$/);
    if (!match || !this.isValidCommand(command)) return null;
    const device = this.byGpio.get(match[1]);
    return {
      command,
      device: match[1],
      gpio: Number(match[1].replace(/^D/, "")),
      state: match[2] === "ON",
      meta: device || null,
    };
  }

  matchDevices(text) {
    const key = normalizeKey(text);
    return this.devices.filter(device => {
      const names = [device.id, device.name, device.displayName, ...(device.alias || [])];
      return names.some(name => {
        const alias = normalizeKey(name);
        return alias && new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(key);
      });
    });
  }

  buildGeminiDeviceLines() {
    return this.devices.map(device => {
      const aliases = [device.name, ...(device.alias || [])].filter(Boolean).join(" / ");
      return `- ${aliases} = ${device.gpio}`;
    }).join("\n");
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { DeviceManager };
