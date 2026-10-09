import { describe, expect, it } from 'vitest';
import { AiAdapterError, AiErrorCode } from '../errors';
import { assertNoPii, findPiiKeys } from '../matching/deidentify';
import { validBundle } from './fixtures';

describe('出站 PII 防线', () => {
  it('合法脱敏输入不产生命中', () => {
    expect(findPiiKeys(validBundle())).toEqual([]);
    expect(() => assertNoPii(validBundle())).not.toThrow();
  });

  it('识别嵌套的敏感字段名并给出路径', () => {
    const findings = findPiiKeys({
      student: { grade: 'junior', contact: { phone: '13800138000', wechatOpenId: 'oX-abc' } },
    });
    expect(findings.map((finding) => finding.path)).toEqual([
      'student.contact.phone',
      'student.contact.wechatOpenId',
    ]);
    expect(findings.every((finding) => finding.reason === 'forbidden_key')).toBe(true);
  });

  it('即使藏在自由文本里也会命中手机号与身份证号', () => {
    const findings = findPiiKeys({ note: '请联系 13800138000 或身份证 11010119900307617X' });
    expect(findings.map((finding) => finding.reason).sort()).toEqual(['id_card', 'phone']);
  });

  it('抛出错误只包含字段路径，不包含字段值', () => {
    try {
      assertNoPii({ student: { name: '张三' } });
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(AiAdapterError);
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.InputPiiDetected);
      expect(JSON.stringify(adapterError.safeDetails)).toContain('student.name');
      expect(JSON.stringify(adapterError.safeDetails)).not.toContain('张三');
    }
  });
});
