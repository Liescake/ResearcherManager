import { z } from 'zod';
import { GROUP_STATUS_VALUES, GroupStatus } from '../enums/status';
import { GRADE_VALUES } from '../enums/taxonomy';
import { tagListSchema, trimmedText, uuidSchema } from './fields';

/** 招募要求：技能、年级、时间、人数（数据字典 research_groups.recruitment_requirements） */
export const recruitmentRequirementsSchema = z.object({
  skills: tagListSchema(0, 20, '技能要求').optional(),
  grades: z.array(z.enum(GRADE_VALUES)).max(6, '年级要求最多 6 项').optional(),
  minWeeklyHours: z
    .number()
    .int('最低每周投入小时数必须是整数')
    .min(0)
    .max(80, '最低每周投入小时数不能超过 80')
    .optional(),
  headcount: z.number().int('招募人数必须是整数').min(1).max(200).optional(),
  note: trimmedText(0, 500, '招募说明').optional(),
});

export type RecruitmentRequirementsInput = z.infer<typeof recruitmentRequirementsSchema>;

export const researchGroupInputSchema = z.object({
  name: trimmedText(1, 100, '小组名称'),
  description: trimmedText(0, 5000, '小组简介').optional(),
  researchDirections: tagListSchema(1, 10, '研究方向'),
  recruitmentRequirements: recruitmentRequirementsSchema,
  leaderUserId: uuidSchema,
  status: z.enum(GROUP_STATUS_VALUES).default('open'),
});

export type ResearchGroupInput = z.infer<typeof researchGroupInputSchema>;

/** 修改小组：仅允许提交需要变更的字段，且不能提交空对象 */
export const researchGroupUpdateSchema = researchGroupInputSchema
  .partial()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少需要提交一个变更字段' });
    }
  });

export type ResearchGroupUpdateInput = z.infer<typeof researchGroupUpdateSchema>;

/**
 * 小组是否可被申请：只有开放状态的小组可申请。
 * 停用/关闭的小组不得通过直接改 URL 提交申请。
 */
export function isGroupApplicable(status: GroupStatus): boolean {
  return status === GroupStatus.Open;
}
