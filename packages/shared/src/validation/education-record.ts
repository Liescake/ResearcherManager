import { z } from 'zod';
import { EDUCATION_STATUS_VALUES, EDUCATION_TYPE_VALUES, EducationStatus } from '../enums/taxonomy';
import { trimmedText, yearSchema } from './fields';

/**
 * 升学记录：年度、类型、状态、院校或去向。
 * 状态必须区分「备考中/已录取/未上岸」；已录取时院校或去向建议必填。
 */
export const educationRecordInputSchema = z
  .object({
    year: yearSchema,
    type: z.enum(EDUCATION_TYPE_VALUES),
    status: z.enum(EDUCATION_STATUS_VALUES),
    institutionOrDestination: trimmedText(0, 200, '院校或去向').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === EducationStatus.Admitted && !value.institutionOrDestination) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['institutionOrDestination'],
        message: '状态为已录取时必须填写院校或去向',
      });
    }
  });

export type EducationRecordInput = z.infer<typeof educationRecordInputSchema>;

export const educationRecordUpdateSchema = educationRecordInputSchema
  .innerType()
  .partial()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少需要提交一个变更字段' });
    }
  });

export type EducationRecordUpdateInput = z.infer<typeof educationRecordUpdateSchema>;
