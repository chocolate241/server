const fs = require("fs");
const { normalizeTranscript } = require("../utils/text");

class DeepgramClient {
  constructor({ env, logger }) {
    this.env = env;
    this.logger = logger;
  }

  async transcribe(audioPath) {
    if (!process.env.DEEPGRAM_API_KEY) {
      throw new Error("Missing DEEPGRAM_API_KEY");
    }
    if (typeof fetch !== "function") {
      throw new Error("Node fetch is not available");
    }

    const params = new URLSearchParams({
      model: this.env.deepgramModel,
      language: this.env.deepgramLanguage,
      smart_format: "false",
      punctuate: "false",
    });

    const audio = await fs.promises.readFile(audioPath);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav",
      },
      body: audio,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Deepgram ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = JSON.parse(body);
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    return {
      transcript: normalizeTranscript(alt?.transcript || ""),
      confidence: Number(alt?.confidence || 0),
    };
  }
}

module.exports = { DeepgramClient };
