import { z } from 'zod';
import {
  ADMIN_CORRECTION_REASON_MAX_LENGTH,
  ADMIN_CORRECTION_REASON_MIN_LENGTH,
} from '../constants';
import { GRADE_VALUES, AVAILABLE_PERIOD_VALUES, PROGRAMMING_LEVEL_VALUES } from '../enums/taxonomy';
import { phoneSchema, riskFreeText, studentNoSchema, tagListSchema, trimmedText } from './fields';

/**
 * 学生画像输入校验，字段与 docs/P1-字段级数据字典.md §1 一一对应。
 * 注意：学号与联系方式属于高敏感字段，仅服务端可见，不进入 AI 输入。
 */

export const availableTimeSchema = z.object({
  weeklyHours: z
    .number()
    .int('每周可投入小时数必须是整数')
    .min(0, '每周可投入小时数不能为负')
    .max(80, '每周可投入小时数不能超过 80'),
  periods: z
    .array(z.enum(AVAILABLE_PERIOD_VALUES))
    .min(1, '至少选择一个空余时间段')
    .max(3, '空余时间段最多 3 项'),
  note: trimmedText(0, 200, '空余时间说明').optional(),
});

export type AvailableTimeInput = z.infer<typeof availableTimeSchema>;

export const privacyConsentSchema = z.object({
  policyVersion: trimmedText(1, 40, '隐私政策版本'),
  agreed: z.literal(true, {
    errorMap: () => ({ message: '必须先同意隐私政策才能提交画像' }),
  }),
  consentedAt: z.coerce.date().optional(),
});

export const studentProfileInputSchema = z.object({
  name: trimmedText(1, 50, '姓名'),
  studentNo: studentNoSchema,
  college: trimmedText(1, 100, '学院'),
  major: trimmedText(1, 100, '专业'),
  grade: z.enum(GRADE_VALUES),
  phone: phoneSchema,
  skills: tagListSchema(1, 20, '擅长技能'),
  programmingLevel: z.enum(PROGRAMMING_LEVEL_VALUES),
  researchExperience: riskFreeText(0, 2000, '科研经历').optional(),
  competitionExperience: riskFreeText(0, 2000, '竞赛经历').optional(),
  availableTime: availableTimeSchema,
  researchInterests: tagListSchema(1, 20, '兴趣研究方向'),
  strengths: riskFreeText(0, 1000, '个人特长与优势').optional(),
  intendedFields: tagListSchema(1, 20, '意向科研领域'),
  privacyConsent: privacyConsentSchema,
});

export type StudentProfileInput = z.infer<typeof studentProfileInputSchema>;

/**
 * 管理员代改：必须携带理由，且至少要修改一个业务字段。
 * 代改必须全量留痕（改前值、改后值、操作人、理由、时间、请求 ID）。
 */
export const adminProfileCorrectionSchema = studentProfileInputSchema
  .partial()
  .extend({
    reason: trimmedText(
      ADMIN_CORRECTION_REASON_MIN_LENGTH,
      ADMIN_CORRECTION_REASON_MAX_LENGTH,
      '代改理由',
    ),
  })
  .superRefine((value, ctx) => {
    const changedFields = Object.keys(value).filter((key) => key !== 'reason');
    if (changedFields.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '代改至少需要提交一个需要修改的字段',
      });
    }
  });

export type AdminProfileCorrectionInput = z.infer<typeof adminProfileCorrectionSchema>;

/** 学生发起的信息更正申请 */
export const profileCorrectionRequestSchema = z.object({
  fieldPaths: z
    .array(trimmedText(1, 60, '字段路径'))
    .min(1, '至少选择一个字段')
    .max(20),
  reason: trimmedText(10, 500, '更正原因'),
});

export type ProfileCorrectionRequestInput = z.infer<typeof profileCorrectionRequestSchema>;
