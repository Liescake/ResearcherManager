/**
 * Provider 端口：适配层只依赖该接口，具体模型服务通过实现替换。
 * 端口职责仅限于「把提示词发出去、把 JSON 拿回来」，
 * schema 校验、重试、降级、审计由适配层统一负责。
 */

export interface AiCompletionRequest {
  modelVersion: string;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
  /** 期望输出的 JSON Schema 提示（字符串形式） */
  schemaHint: string;
  signal: AbortSignal;
}

export interface AiProvider {
  /** 便于日志与审计记录的 provider 标识（不含密钥） */
  readonly id: string;
  completeJson(request: AiCompletionRequest): Promise<unknown>;
}
