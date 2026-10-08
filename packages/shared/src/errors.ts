/**
 * 业务错误类型：供状态机、校验和领域规则抛出，由 API 层统一转成错误码响应。
 */

export class BusinessRuleError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BusinessRuleError';
    this.code = code;
    this.details = details;
  }
}

export class StateTransitionError extends BusinessRuleError {
  constructor(entity: string, from: string, to: string) {
    super('STATE_TRANSITION_INVALID', `${entity} 不允许从 ${from} 转移到 ${to}`, {
      entity,
      from,
      to,
    });
    this.name = 'StateTransitionError';
  }
}
