import OpenAI from "openai";

export interface LlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  maxTokens?: number; // user override for the long-output ceiling
}

export function resolveLlmConfig(opts: {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
}): LlmConfig {
  const apiKey =
    opts.apiKey || process.env.DESIGNFORGE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No LLM API key found. Pass --api-key or set OPENAI_API_KEY / DESIGNFORGE_API_KEY.\n" +
        "designforge uses your own key (BYOK) and never stores it."
    );
  }
  const baseURL =
    opts.baseURL || process.env.DESIGNFORGE_BASE_URL || process.env.OPENAI_BASE_URL;
  const model = opts.model || process.env.DESIGNFORGE_MODEL || "gpt-4o-mini";
  const envMax = process.env.DESIGNFORGE_MAX_TOKENS ? parseInt(process.env.DESIGNFORGE_MAX_TOKENS, 10) : undefined;
  const maxTokens = opts.maxTokens || (Number.isFinite(envMax) ? envMax : undefined);
  return { apiKey, baseURL, model, maxTokens };
}

/** Strip markdown code fences and pull the first {...} / [...] JSON block out of text. */
function extractJson(raw: string): string {
  let s = (raw || "").trim();
  // 1) pull out a fenced block anywhere in the text (```json ... ``` or ``` ... ```)
  const fenceAny = s.match(/\`\`\`(?:json|JSON)?\s*([\s\S]*?)\s*\`\`\`/);
  if (fenceAny && /[{[]/.test(fenceAny[1])) s = fenceAny[1].trim();
  // 2) if it already starts clean, done
  if (s.startsWith("{") || s.startsWith("[")) return balancedSlice(s);
  // 3) otherwise scan for the first balanced {...} / [...] block (handles prose around JSON)
  const i = s.search(/[{[]/);
  if (i >= 0) return balancedSlice(s.slice(i));
  return s.trim();
}

/** Return the substring from the start char to its matching close, respecting strings/escapes. */
function balancedSlice(s: string): string {
  const open = s[0];
  if (open !== "{" && open !== "[") return s.trim();
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return s.slice(0, i + 1).trim(); }
  }
  // unbalanced (likely truncated) -> return as-is for the parser to report
  return s.trim();
}

/** Whether the error means our requested max_tokens is larger than the model allows. */
function maxTokensTooLarge(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /max_tokens|max_completion_tokens|maximum.*token|token.*exceed|exceed.*(context|limit)|too (large|many).*token/.test(msg)
    && /(exceed|too (large|many)|greater than|larger than|less than or equal|maximum)/.test(msg);
}

/** Whether a thrown provider error complains about an unsupported param. */
function complainsAbout(err: unknown, param: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const re = new RegExp(param + "[^a-z]{0,4}(is )?(deprecated|not supported|unsupported|unknown|invalid)", "i");
  return re.test(msg) || (new RegExp("(deprecated|not supported|unsupported).{0,40}" + param, "i")).test(msg);
}

/** Map raw provider errors to a friendly Chinese-first message for common failures. */
function friendlyError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();
  if (low.includes("geographic") || low.includes("geo restrict") || low.includes("region") && low.includes("block") || low.includes("permission_denied") && low.includes("geo")) {
    return new Error("\u8be5\u6a21\u578b\u670d\u52a1\u5546\u6309\u5730\u533a\u5c01\u9501\u4e86\u4f60\u7684\u7f51\u7edc\uff08geographic restrictions\uff09\u3002\u8bf7\u6362\u4e00\u5bb6\u56fd\u5185\u53ef\u76f4\u8fde\u7684\u670d\u52a1\u5546\uff08\u5982 DeepSeek / \u963f\u91cc\u767e\u70bc / \u667a\u8c31\uff09\uff0c\u6216\u6302\u6d77\u5916\u4ee3\u7406\u540e\u91cd\u8bd5\u3002\n\uff08\u539f\u59cb\u9519\u8bef\uff1a" + raw.slice(0, 180) + "\uff09");
  }
  if (low.includes("401") || low.includes("invalid api key") || low.includes("unauthorized") || low.includes("incorrect api key")) {
    return new Error("\u8ba4\u8bc1\u5931\u8d25\uff1aAPI Key \u65e0\u6548\u6216\u4e0e Base URL \u4e0d\u5339\u914d\u3002\u8bf7\u68c0\u67e5\u8bbe\u7f6e\u3002\n\uff08\u539f\u59cb\u9519\u8bef\uff1a" + raw.slice(0, 160) + "\uff09");
  }
  if (low.includes("429") || low.includes("rate limit") || low.includes("quota")) {
    return new Error("\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\u6216\u989d\u5ea6\u4e0d\u8db3\uff08rate limit / quota\uff09\u3002\u7a0d\u540e\u91cd\u8bd5\u6216\u6362\u4e00\u4e2a key\u3002\n\uff08\u539f\u59cb\u9519\u8bef\uff1a" + raw.slice(0, 160) + "\uff09");
  }
  return err instanceof Error ? err : new Error(raw);
}

export class LlmClient {
  private client: OpenAI;
  readonly model: string;
  // params the current model rejects; we drop them and retry.
  private drop = { temperature: false, responseFormat: false, maxTokens: false };
  // ceiling for long outputs (page.tsx / html); halved on "exceeds limit" errors.
  private longCeiling: number;

  constructor(cfg: LlmConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
    const want = cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : 16384;
    this.longCeiling = Math.min(Math.max(want, 1024), 65536);
  }

  private async create(messages: { role: "system" | "user"; content: string }[], opts: { temperature: number; json: boolean; maxTokens?: number }): Promise<string> {
    let budget = opts.maxTokens && opts.maxTokens > 0 ? Math.min(opts.maxTokens, this.longCeiling) : this.longCeiling;
    const attempt = async (): Promise<string> => {
      const body: Record<string, unknown> = { model: this.model, messages };
      if (!this.drop.temperature) body.temperature = opts.temperature;
      if (!this.drop.maxTokens) body.max_tokens = budget;
      if (opts.json && !this.drop.responseFormat) body.response_format = { type: "json_object" };
      const res = await this.client.chat.completions.create(body as any);
      return (res as any).choices?.[0]?.message?.content || "";
    };
    try {
      return await attempt();
    } catch (e) {
      let retried = false;
      // If our requested budget is over the model ceiling, halve it (down to 1024) and retry.
      if (!this.drop.maxTokens && maxTokensTooLarge(e) && budget > 1024) {
        budget = Math.max(1024, Math.floor(budget / 2));
        this.longCeiling = Math.min(this.longCeiling, budget);
        retried = true;
      }
      if (!this.drop.temperature && complainsAbout(e, "temperature")) { this.drop.temperature = true; retried = true; }
      if (!this.drop.maxTokens && !retried && complainsAbout(e, "max_tokens")) { this.drop.maxTokens = true; retried = true; }
      if (opts.json && !this.drop.responseFormat && complainsAbout(e, "response_format")) { this.drop.responseFormat = true; retried = true; }
      if (retried) {
        try { return await attempt(); } catch (e2) { throw friendlyError(e2); }
      }
      throw friendlyError(e);
    }
  }

  async json<T>(system: string, user: string, maxTokens?: number): Promise<T> {
    // nudge plain-text JSON for models that ignore response_format
    const sys = system + "\n\nIMPORTANT: Respond with raw JSON only. No markdown, no code fences, no commentary.";
    const txt = await this.create(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { temperature: 0.4, json: true, maxTokens }
    );
    const cleaned = extractJson(txt);
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // One repair attempt: hand the bad output back and ask for strict JSON only.
      try {
        const fixTxt = await this.create(
          [
            { role: "system", content: "You convert text into a single valid JSON value. Output ONLY raw JSON — no prose, no markdown, no code fences. Do not truncate." },
            { role: "user", content: "Return ONLY the corrected, complete JSON for the following content:\n\n" + txt.slice(0, 12000) },
          ],
          { temperature: 0, json: true }
        );
        return JSON.parse(extractJson(fixTxt)) as T;
      } catch { /* fall through to the friendly error */ }
      throw new Error("\u6a21\u578b\u8fd4\u56de\u7684\u4e0d\u662f\u6709\u6548 JSON\uff08\u5df2\u5c1d\u8bd5\u53bb\u9664\u4ee3\u7801\u5757\u4e0e\u4fee\u590d\uff09\u3002\u53ef\u80fd\u662f\u8f93\u51fa\u88ab\u622a\u65ad\uff08\u5185\u5bb9\u8fc7\u957f\uff09\u6216\u8be5\u4e2d\u8f6c\u63a5\u53e3\u4e0d\u652f\u6301 response_format\u3002\u8bf7\u91cd\u8bd5\uff0c\u6216\u6362\u4e00\u4e2a\u66f4\u64c5\u957f\u6307\u4ee4\u9075\u5faa\u7684\u6a21\u578b\uff08\u5982 gpt-4o-mini / deepseek-chat / qwen-plus \u7b49\uff09\u3002");
    }
  }

  /** JSON completion that can also receive images (data URLs) for visual grounding. */
  async jsonWithImages<T>(system: string, user: string, images: string[]): Promise<T> {
    const sys = system + "\n\nIMPORTANT: Respond with raw JSON only. No markdown, no code fences, no commentary.";
    const content: any[] = [{ type: "text", text: user }];
    for (const img of images) {
      if (img && img.startsWith("data:")) content.push({ type: "image_url", image_url: { url: img } });
    }
    const attempt = async (): Promise<string> => {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content },
        ],
      };
      if (!this.drop.temperature) body.temperature = 0.4;
      if (!this.drop.maxTokens) body.max_tokens = 8192;
      if (!this.drop.responseFormat) body.response_format = { type: "json_object" };
      const res = await this.client.chat.completions.create(body as any);
      return (res as any).choices?.[0]?.message?.content || "";
    };
    let txt = "";
    try {
      txt = await attempt();
    } catch (e) {
      let retried = false;
      if (!this.drop.temperature && complainsAbout(e, "temperature")) { this.drop.temperature = true; retried = true; }
      if (!this.drop.responseFormat && complainsAbout(e, "response_format")) { this.drop.responseFormat = true; retried = true; }
      if (retried) {
        try { txt = await attempt(); } catch (e2) { throw friendlyError(e2); }
      } else {
        throw friendlyError(e);
      }
    }
    const cleaned = extractJson(txt);
    try { return JSON.parse(cleaned) as T; }
    catch { throw new Error("\u6a21\u578b\u8fd4\u56de\u7684\u4e0d\u662f\u6709\u6548 JSON\uff08\u542b\u56fe\u7247\u8bf7\u6c42\uff09\u3002\u8bf7\u6362\u4e00\u4e2a\u652f\u6301\u89c6\u89c9\u4e14\u80fd\u4e25\u683c\u8f93\u51fa JSON \u7684\u6a21\u578b\u3002"); }
  }

  async text(system: string, user: string, temperature = 0.6): Promise<string> {
    return this.create(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature, json: false }
    );
  }
}
