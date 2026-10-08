import { z } from 'zod';

/**
 * 通用字段级校验原语。
 * 规则来源：docs/P1-字段级数据字典.md（长度、取值范围、内容安全）。
 */

export const uuidSchema = z.string().uuid('必须是合法的 UUID');

/** 控制字符（保留 \t \n \r）一律拒绝，防止日志注入与展示错乱 */
// eslint-disable-next-line no-control-regex -- intentionally detects forbidden control characters
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function trimmedText(min: number, max: number, label = '字段'): z.ZodType<string> {
  const message = `${label}长度需在 ${min}-${max} 之间`;
  return z
    .string()
    .trim()
    .min(min, message)
    .max(max, message)
    .refine((value) => !CONTROL_CHARS.test(value), { message: `${label}包含非法控制字符` });
}

/** 手机号：支持大陆手机号、带 +86 前缀以及 E.164 */
export const PHONE_PATTERN = /^(?:\+?86)?1[3-9]\d{9}$|^\+[1-9]\d{6,14}$/;
export const phoneSchema = z
  .string()
  .trim()
  .min(6, '联系方式长度需在 6-20 之间')
  .max(20, '联系方式长度需在 6-20 之间')
  .regex(PHONE_PATTERN, '联系方式格式不正确（支持大陆手机号或 E.164）')
  .refine((value) => !CONTROL_CHARS.test(value), { message: '联系方式包含非法控制字符' });

/** 学号：格式由配置定义，此处限制为字母数字与短横线，长度 4—32 */
export const studentNoSchema = z
  .string()
  .trim()
  .min(4, '学号长度需在 4-32 之间')
  .max(32, '学号长度需在 4-32 之间')
  .regex(/^[A-Za-z0-9-]+$/, '学号只允许字母、数字和短横线');

/** 标签数组：去重、去空、限制条数 */
export function tagListSchema(min = 1, max = 20, label = '标签'): z.ZodType<string[]> {
  return z
    .array(trimmedText(1, 50, label))
    .min(min, `${label}至少 ${min} 项`)
    .max(max, `${label}最多 ${max} 项`)
    .transform((values) => [...new Set(values)]);
}

export type HighRiskCode = 'id_card' | 'long_numeric_id' | 'secret_like';

export interface HighRiskFinding {
  code: HighRiskCode;
  /** 只返回掩码片段，绝不回显原文 */
  maskedSample: string;
  message: string;
}

const HIGH_RISK_PATTERNS: readonly {
  code: HighRiskCode;
  pattern: RegExp;
  message: string;
}[] = [
  {
    code: 'id_card',
    pattern: /\b\d{17}[\dXx]\b/,
    message: '疑似身份证号，禁止填写证件类敏感信息',
  },
  {
    code: 'long_numeric_id',
    pattern: /\b\d{16,25}\b/,
    message: '疑似银行卡号或长数字标识，禁止填写',
  },
  {
    code: 'secret_like',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*\S{8,}/i,
    message: '疑似密钥或口令，禁止填写',
  },
];

function maskSample(value: string): string {
  if (value.length <= 5) {
    return '***';
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

/** 检测高敏感内容，返回掩码后的命中结果，用于表单校验和审计告警 */
export function detectHighRiskContent(value: string): HighRiskFinding[] {
  const findings: HighRiskFinding[] = [];
  for (const { code, pattern, message } of HIGH_RISK_PATTERNS) {
    const match = pattern.exec(value);
    if (match?.[0]) {
      findings.push({ code, maskedSample: maskSample(match[0]), message });
    }
  }
  return findings;
}

/** 长文本字段：长度校验 + 禁止身份证/密钥等敏感信息（数据字典 §5.1） */
export function riskFreeText(min: number, max: number, label = '文本'): z.ZodType<string> {
  return trimmedText(min, max, label).superRefine((value, ctx) => {
    for (const finding of detectHighRiskContent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: finding.message });
    }
  });
}

/** 幂等键：写接口必填，长度下限 8，禁止空白字符 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, '幂等键长度需在 8-128 之间')
  .max(128, '幂等键长度需在 8-128 之间')
  .regex(/^[A-Za-z0-9._:-]+$/, '幂等键只允许字母、数字和 . _ : -');

/** 允许的年份范围（升学记录等） */
export const yearSchema = z
  .number()
  .int('年份必须是整数')
  .min(2000, '年份不能早于 2000')
  .max(2100, '年份不能晚于 2100');
