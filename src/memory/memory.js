const { createClient } = require("@supabase/supabase-js");
const { normalizeKey } = require("../utils/text");

class CommandMemory {
  constructor({ localParser, logger }) {
    this.localParser = localParser;
    this.logger = logger;
    this.map = new Map();
    this.supabase = null;
    this.extendedSchema = true;
  }

  connect() {
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) {
      this.logger.warn("Supabase disabled, missing env: " + missing.join(", "));
      return false;
    }
    this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return true;
  }

  async load() {
    if (!this.supabase && !this.connect()) return;
    try {
      const { data, error } = await this.supabase.from("command_memory").select("*");
      if (error) {
        this.logger.warn("load failed: " + error.message);
        return;
      }
      this.map.clear();
      for (const row of data || []) {
        if (!row.key || !this.localParser.isValidCommands(row.commands)) continue;
        this.map.set(row.key, {
          text: row.text || row.key,
          commands: row.commands,
          confidence: Number(row.confidence || 0),
          verified: row.verified === true,
          hit_count: Number(row.hit_count || 0),
          last_used: row.last_used || null,
        });
      }
      this.logger.info(`loaded ${this.map.size} records`);
    } catch (err) {
      this.logger.warn("load error: " + err.message);
    }
  }

  getVerified(text) {
    const key = normalizeKey(text);
    const record = this.map.get(key);
    if (!record || !record.verified) return null;
    this.markUsed(key, record).catch(err => this.logger.warn("mark used failed: " + err.message));
    return { source: "memory", commands: record.commands, confidence: record.confidence };
  }

  async markUsed(key, record) {
    record.hit_count += 1;
    record.last_used = new Date().toISOString();
    if (!this.supabase || !this.extendedSchema) return;
    const { error } = await this.supabase.from("command_memory").update({
      hit_count: record.hit_count,
      last_used: record.last_used,
    }).eq("key", key);
    if (error && this.isMissingExtendedColumn(error)) {
      this.extendedSchema = false;
      this.logger.warn("using legacy command_memory schema, hit_count disabled");
    }
  }

  async saveCandidate(text, commands, confidence, verified = false) {
    if (!this.localParser.isValidCommands(commands) || !commands.length) return;
    if (!this.localParser.isLikelySmartHomeCommand(text)) return;

    const key = normalizeKey(text);
    const now = new Date().toISOString();
    const record = {
      key,
      text,
      commands,
      confidence,
      verified,
      hit_count: 0,
      last_used: null,
      updated_at: now,
    };

    this.map.set(key, record);
    if (!this.supabase && !this.connect()) return;

    try {
      const payload = this.extendedSchema
        ? { ...record, created_at: now }
        : this.legacyPayload(record, now);
      let { error } = await this.supabase.from("command_memory").upsert(payload);

      if (error && this.extendedSchema && this.isMissingExtendedColumn(error)) {
        this.extendedSchema = false;
        this.logger.warn("Supabase table is legacy; run README schema SQL when convenient");
        const retry = await this.supabase.from("command_memory").upsert(this.legacyPayload(record, now));
        error = retry.error;
      }

      if (error) this.logger.warn("save failed: " + error.message);
    } catch (err) {
      this.logger.warn("save error: " + err.message);
    }
  }

  legacyPayload(record, now) {
    return {
      key: record.key,
      text: record.text,
      commands: record.commands,
      created_at: now,
      updated_at: record.updated_at || now,
    };
  }

  isMissingExtendedColumn(error) {
    const message = String(error?.message || "");
    return /could not find .* column|schema cache|confidence|verified|hit_count|last_used/i.test(message);
  }

  async clear() {
    this.map.clear();
    if (!this.supabase && !this.connect()) return;
    const { error } = await this.supabase.from("command_memory").delete().neq("key", "__never__");
    if (error) throw error;
  }

  toJSON() {
    return Object.fromEntries(this.map);
  }

  size() {
    return this.map.size;
  }

  async health() {
    if (!this.supabase && !this.connect()) return false;
    const { error } = await this.supabase.from("command_memory").select("key").limit(1);
    return !error;
  }
}

module.exports = { CommandMemory };
