import { AiAdapterError, AiErrorCode } from '../errors';

/**
 * 出站前 PII 防线：即使调用方写错了字段，也不能把姓名/学号/手机号/微信标识发给模型。
 * 命中即阻断模型调用（调用方随后走规则降级）。
 */

const FORBIDDEN_KEYS = new Set([
  'name',
  'realname',
  'real_name',
  'studentno',
  'student_no',
  'sno',
  'phone',
  'mobile',
  'telephone',
  'wechatopenid',
  'wechat_open_id',
  'openid',
  'open_id',
  'unionid',
  'union_id',
  'idcard',
  'id_card',
  'idnumber',
  'password',
  'passwd',
  'token',
  'accesstoken',
  'access_token',
  'sessionkey',
  'session_key',
  'secret',
]);

/** 值级别扫描：手机号与身份证号即使藏在自由文本里也要拦住 */
const PII_VALUE_PATTERNS: readonly { code: string; pattern: RegExp }[] = [
  { code: 'phone', pattern: /\b1[3-9]\d{9}\b/u },
  { code: 'id_card', pattern: /\b\d{17}[\dXx]\b/u },
];

export interface PiiFinding {
  /** 字段路径，例如 student.name */
  path: string;
  /** 命中原因：forbidden_key | phone | id_card */
  reason: string;
}

function scan(value: unknown, path: string, depth: number, findings: PiiFinding[]): void {
  if (findings.length >= 20 || depth > 8) {
    return;
  }
  if (typeof value === 'string') {
    for (const { code, pattern } of PII_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({ path, reason: code });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}[${index}]`, depth + 1, findings));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const itemPath = path ? `${path}.${key}` : key;
      // Candidate group display names are non-personal labels used for matching;
      // all other `name` fields remain forbidden by the outbound PII boundary.
      const isCandidateDisplayName = /^candidates\[\d+\]\.name$/u.test(itemPath);
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) && !isCandidateDisplayName) {
        findings.push({ path: itemPath, reason: 'forbidden_key' });
        continue;
      }
      scan(item, path ? `${path}.${key}` : key, depth + 1, findings);
    }
  }
}

export function findPiiKeys(value: unknown): PiiFinding[] {
  const findings: PiiFinding[] = [];
  scan(value, '', 0, findings);
  return findings;
}

/** 命中时抛出；错误详情只包含字段路径，不包含字段值 */
export function assertNoPii(value: unknown): void {
  const findings = findPiiKeys(value);
  if (findings.length > 0) {
    throw new AiAdapterError(AiErrorCode.InputPiiDetected, undefined, {
      findings: findings.map((finding) => `${finding.path}:${finding.reason}`),
    });
  }
}
