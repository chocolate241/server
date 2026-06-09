const { normalizeKey, normalizeTranscript } = require("../utils/text");

const DELAY_RE = /^DELAY:\d+$/;

function createLocalParser(deviceManager) {
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function deviceAliases(device) {
    return [device.id, device.name, device.displayName, ...(device.alias || [])]
      .map(alias => normalizeKey(alias))
      .filter(Boolean);
  }

  function textMentionsDevice(key, device) {
    return deviceAliases(device).some(alias => new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(key));
  }

  function negationIndex(key) {
    const match = key.match(/\b(dung|khong|tranh|ngoai tru|tru)\b/);
    return match ? match.index : -1;
  }

  function negatedDevices(key) {
    const index = negationIndex(key);
    if (index < 0) return [];
    const negatedPart = key.slice(index);
    return deviceManager.getDevices().filter(device => textMentionsDevice(negatedPart, device));
  }

  function hasPrimaryActionBeforeNegation(key) {
    const action = key.search(/\b(bat|mo|sang|len|tat|dong)\b/);
    const neg = negationIndex(key);
    return action >= 0 && (neg < 0 || action < neg);
  }

  function parseDelayMs(key) {
    const match = key.match(/\b(\d+)\s*(giay|s|phut|p)\b/);
    if (!match) return 0;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return /^(phut|p)$/.test(match[2]) ? value * 60000 : value * 1000;
  }

  function addCommand(commands, gpio, wantsOn) {
    const command = gpio + (wantsOn ? "_ON" : "_OFF");
    if (!commands.includes(command)) commands.push(command);
  }

  function isValidCommands(commands) {
    const validCommands = deviceManager.getValidCommands();
    return Array.isArray(commands) &&
      commands.every(command => typeof command === "string" && (DELAY_RE.test(command) || validCommands.has(command)));
  }

  function isLikelySmartHomeCommand(text) {
    const key = normalizeKey(text);
    const raw = String(text || "").toLowerCase();
    if (key.length < 4) return false;

    const hasAction =
      /\b(bat|tat|mo|dong|sang|len)\b/.test(key) ||
      (/\b(cac|cat)\b/.test(key) && /\b(het|den|dien)\b/.test(key)) ||
      /(b\u1eadt|t\u1eaft|m\u1edf|\u0111\u00f3ng|s\u00e1ng|l\u00ean)/u.test(raw);

    const hasTarget =
      deviceManager.matchDevices(text).length > 0 ||
      /\b(den|dien|phong|tat ca|het|toan bo|all|light|lights)\b/.test(key) ||
      /(\u0111\u00e8n|\u0111i\u1ec7n|ph\u00f2ng|t\u1ea5t c\u1ea3|h\u1ebft)/u.test(raw);

    return hasAction && hasTarget;
  }

  function parse(text) {
    const key = normalizeKey(text);
    if (!key) return null;

    const actionKey = key.replace(/\btat ca\b/g, "all");
    const wantsOn = /\b(bat|mo|sang|len)\b/.test(actionKey);
    const wantsOff =
      /\b(tat|dong)\b/.test(actionKey) ||
      (/\b(cac|cat)\b/.test(actionKey) && /\b(het|den|dien)\b/.test(actionKey));

    const excluded = negatedDevices(key);
    const excludedGpios = new Set(excluded.map(device => device.gpio));
    const matched = deviceManager.matchDevices(text).filter(device => !excludedGpios.has(device.gpio));
    const hasExactRoom = matched.length > 0;
    const hasRoomIntent = /\b(phong|room)\b/.test(key);
    const hasFuzzyRoom = /\b(khac|khat|khachh|nguoi|beep)\b/.test(key);
    const hasSoftQualifier = /\b(moi|thoi|chi|duy nhat|rieng)\b/.test(key);
    const hasExclusion = excluded.length > 0;
    const primaryPart = negationIndex(key) >= 0 ? key.slice(0, negationIndex(key)) : key;
    const otherLightsIntent =
      /\b(kia|con lai|ngoai|tru|2 den|hai den|may den)\b/.test(key) ||
      /\b(bat den|tat den|bat dien|tat dien|tat ca|het|toan bo|all)\b/.test(primaryPart);
    const hasAllButTarget = hasExclusion && hasPrimaryActionBeforeNegation(key) && otherLightsIntent;

    if ((hasRoomIntent || hasFuzzyRoom || hasSoftQualifier) && !hasExactRoom && !hasAllButTarget) {
      return null;
    }

    const allLights =
      /\b(tat ca|het|toan bo|den het|dien het|all)\b/.test(key) ||
      (/\b(tat den|bat den|tat dien|bat dien)\b/.test(key) && !hasRoomIntent && !hasExactRoom && !hasSoftQualifier);

    let targets = allLights ? deviceManager.getDevices() : matched;
    if (hasAllButTarget) {
      targets = deviceManager.getDevices().filter(device => !excludedGpios.has(device.gpio));
    }
    if (!targets.length) return null;

    const delayMs = parseDelayMs(key);
    if (wantsOn && wantsOff && delayMs) {
      const onIndex = key.search(/\b(bat|mo|sang|len)\b/);
      const offIndex = key.search(/\b(tat|dong|cac|cat)\b/);
      const startOn = onIndex >= 0 && (offIndex < 0 || onIndex < offIndex);
      const commands = [];
      for (const device of targets) addCommand(commands, device.gpio, startOn);
      commands.push("DELAY:" + delayMs);
      for (const device of targets) addCommand(commands, device.gpio, !startOn);
      return { source: "local", commands, confidence: 0.95 };
    }

    if (wantsOn === wantsOff) return null;

    const commands = [];
    for (const device of targets) addCommand(commands, device.gpio, wantsOn);
    return commands.length ? { source: "local", commands, confidence: 0.95 } : null;
  }

  function commandPolarity(commands) {
    const validCommands = deviceManager.getValidCommands();
    const direct = (commands || []).filter(command => validCommands.has(command));
    if (!direct.length) return "";
    const hasOn = direct.some(command => command.endsWith("_ON"));
    const hasOff = direct.some(command => command.endsWith("_OFF"));
    if (hasOn === hasOff) return "";
    return hasOn ? "on" : "off";
  }

  function isAllLightCommand(commands) {
    const validCommands = deviceManager.getValidCommands();
    const direct = new Set((commands || []).filter(command => validCommands.has(command)));
    return deviceManager.getDevicePins().every(gpio => direct.has(gpio + "_ON") || direct.has(gpio + "_OFF"));
  }

  function shouldBypassMemory(text) {
    const key = normalizeKey(text);
    if (!key) return false;
    const hasExactRoom = deviceManager.matchDevices(text).length > 0;
    const hasRoomIntent = /\b(phong|room)\b/.test(key);
    const hasFuzzyRoom = /\b(khac|khat|khachh|beep)\b/.test(key);
    const hasSoftQualifier = /\b(moi|thoi|chi|duy nhat|rieng)\b/.test(key);
    return (hasFuzzyRoom || hasSoftQualifier || hasRoomIntent) && !hasExactRoom;
  }

  return {
    parse,
    isLikelySmartHomeCommand,
    isValidCommands,
    commandPolarity,
    isAllLightCommand,
    shouldBypassMemory,
    normalizeTranscript,
    normalizeKey,
    delayRe: DELAY_RE,
  };
}

module.exports = { createLocalParser };
