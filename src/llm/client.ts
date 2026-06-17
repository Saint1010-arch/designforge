import OpenAI from "openai";

export interface LlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export function resolveLlmConfig(opts: {
  apiKey?: string;
  baseURL?: string;
  model?: string;
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
  return { apiKey, baseURL, model };
}

/** Strip markdown code fences and pull the first {...} / [...] JSON block out of text. */
function extractJson(raw: string): string {
  let s = (raw || "").trim();
  // remove leading/trailing markdown fences like ```json ... ```
  const fence = s.match(/^\`\`\`(?:json|JSON)?\s*([\s\S]*?)\s*\`\`\`$/);
  if (fence) s = fence[1].trim();
  // if still wrapped, grab the outermost JSON object/array
  if (!(s.startsWith("{") || s.startsWith("["))) {
    const i = s.search(/[{[]/);
    if (i >= 0) {
      const open = s[i];
      const close = open === "{" ? "}" : "]";
      const j = s.lastIndexOf(close);
      if (j > i) s = s.slice(i, j + 1);
    }
  }
  return s.trim();
}

/** Whether a thrown provider error complains about an unsupported param. */
function complainsAbout(err: unknown, param: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const re = new RegExp(param + "[^a-z]{0,4}(is )?(deprecated|not supported|unsupported|unknown|invalid)", "i");
  return re.test(msg) || (new RegExp("(deprecated|not supported|unsupported).{0,40}" + param, "i")).test(msg);
}

export class LlmClient {
  private client: OpenAI;
  readonly model: string;
  // params the current model rejects; we drop them and retry.
  private drop = { temperature: false, responseFormat: false };

  constructor(cfg: LlmConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
  }

  private async create(messages: { role: "system" | "user"; content: string }[], opts: { temperature: number; json: boolean }): Promise<string> {
    const attempt = async (): Promise<string> => {
      const body: Record<string, unknown> = { model: this.model, messages };
      if (!this.drop.temperature) body.temperature = opts.temperature;
      if (opts.json && !this.drop.responseFormat) body.response_format = { type: "json_object" };
      const res = await this.client.chat.completions.create(body as any);
      return (res as any).choices?.[0]?.message?.content || "";
    };
    try {
      return await attempt();
    } catch (e) {
      let retried = false;
      if (!this.drop.temperature && complainsAbout(e, "temperature")) { this.drop.temperature = true; retried = true; }
      if (opts.json && !this.drop.responseFormat && complainsAbout(e, "response_format")) { this.drop.responseFormat = true; retried = true; }
      if (retried) return await attempt();
      throw e;
    }
  }

  async json<T>(system: string, user: string): Promise<T> {
    // nudge plain-text JSON for models that ignore response_format
    const sys = system + "\n\nIMPORTANT: Respond with raw JSON only. No markdown, no code fences, no commentary.";
    const txt = await this.create(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { temperature: 0.4, json: true }
    );
    const cleaned = extractJson(txt);
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      throw new Error("\u6a21\u578b\u8fd4\u56de\u7684\u4e0d\u662f\u6709\u6548 JSON\uff08\u5df2\u5c1d\u8bd5\u53bb\u9664\u4ee3\u7801\u5757\uff09\u3002\u8bf7\u6362\u4e00\u4e2a\u66f4\u64c5\u957f\u6307\u4ee4\u9075\u5faa\u7684\u6a21\u578b\uff08\u5982 gpt-4o-mini / deepseek-chat / qwen-plus \u7b49\uff09\u3002");
    }
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
