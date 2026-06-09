function normalizeTranscript(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeKey(text) {
  return normalizeTranscript(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(text, max = 90) {
  const normalized = normalizeTranscript(text);
  return normalized.length > max ? normalized.slice(0, max) + "..." : normalized;
}

function isGarbageTranscript(text, isLikelyCommand) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return true;

  const key = normalizeKey(normalized);
  if (!key) return true;

  const garbagePatterns = [
    /\b(cam on|xin chao|hen gap|video|dang ky|subscribe|like|share)\b/,
    /\b(dung co bo lo|dung bo lo|bo lo|don tim thay)\b/,
    /\b(thank you|thanks|watching)\b/,
  ];
  if (garbagePatterns.some(re => re.test(key))) return true;

  const repeatedPhrase = /\b(.{6,35}?)\b(?:[,.!? ]+\1\b){3,}/i;
  if (repeatedPhrase.test(normalized)) return true;

  return normalized.length > 180 && !(isLikelyCommand && isLikelyCommand(normalized));
}

function cleanTranscript(text, isLikelyCommand) {
  const normalized = normalizeTranscript(text);
  return isGarbageTranscript(normalized, isLikelyCommand) ? "" : normalized;
}

function correctSmartHomeTranscript(text) {
  let out = normalizeTranscript(text);
  if (!out) return "";

  const key = normalizeKey(out);
  const looksLikeLightCommand =
    /\b(bat|tat|mo|dong|cac|cat)\b/.test(key) &&
    /\b(phong|khach|ngu|bep|het|den|dien)\b/.test(key);

  if (!looksLikeLightCommand) return out;

  return out
    .replace(/\b[Bb]ất\b/g, "Bật")
    .replace(/\b[Cc]ác hết đèn\b/g, "Tắt hết đèn")
    .replace(/\b[Cc]ắt hết đèn\b/g, "Tắt hết đèn")
    .replace(/\b(chuyện|kênh|đêm|đến)\b/giu, "đèn")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  normalizeTranscript,
  normalizeKey,
  shortText,
  cleanTranscript,
  correctSmartHomeTranscript,
};
