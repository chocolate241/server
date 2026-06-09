const { GoogleGenAI } = require("@google/genai");

class GeminiParser {
  constructor({ deviceManager, env, logger, localParser }) {
    this.deviceManager = deviceManager;
    this.env = env;
    this.logger = logger;
    this.localParser = localParser;
    this.ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
  }

  buildPrompt(text) {
    const devicePins = this.deviceManager.getDevicePins();
    const validCommands = [...this.deviceManager.getValidCommands(), "DELAY:<ms>"].join(", ");
    const allOff = devicePins.map(gpio => `${gpio}_OFF`).join('","');
    const first = this.deviceManager.getDevices()[0];
    const delayDevice =
      this.deviceManager.getDevices().find(device => (device.alias || []).some(alias => /bếp|bep/i.test(alias))) ||
      first;

    return `
You are a smart-home command parser. Convert the user's Vietnamese command to JSON only.

Devices:
${this.deviceManager.buildGeminiDeviceLines()}
- all lights / tat ca / het / toan bo / moi phong = ${devicePins.join(", ")}

Valid commands: ${validCommands}

Rules:
- Return exactly one JSON object. No markdown, no explanation.
- If the text is not about lights, return {"commands":[]}.
- If user says bat den without a room, turn on all lights.
- If user says tat den without a room, turn off all lights.
- Use the final intention if the user corrects themselves.
- Multiple rooms and delays are allowed.

Examples:
"bat den phong khach" -> {"commands":["${first?.gpio || "PIN"}_ON"]}
"tat het den" -> {"commands":["${allOff}"]}
"bat den bep 5 giay roi tat" -> {"commands":["${delayDevice?.gpio || "PIN"}_ON","DELAY:5000","${delayDevice?.gpio || "PIN"}_OFF"]}

User text: "${text}"

JSON:`.trim();
  }

  async parse(text) {
    if (!this.ai) {
      this.logger.warn("missing GEMINI_API_KEY");
      return { source: "gemini", commands: [], confidence: 0 };
    }

    const res = await this.ai.models.generateContent({
      model: this.env.geminiModel,
      contents: this.buildPrompt(text),
      config: { temperature: 0.1 },
    });

    const raw = res.text.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    const commands = parsed.commands || [];
    if (!this.localParser.isValidCommands(commands)) {
      throw new Error("Gemini returned invalid commands: " + raw);
    }
    return { source: "gemini", commands, confidence: commands.length ? 0.7 : 0 };
  }
}

module.exports = { GeminiParser };
