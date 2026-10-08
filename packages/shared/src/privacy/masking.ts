/**
 * 脱敏展示工具（数据字典 §5.1）：
 * 学号、手机号、姓名等敏感字段默认掩码展示；日志与错误信息中不得出现明文。
 */

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/gu, '');
  if (digits.length < 7) {
    return '***';
  }
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function maskStudentNo(studentNo: string): string {
  if (studentNo.length <= 4) {
    return '***';
  }
  return `${studentNo.slice(0, 2)}${'*'.repeat(Math.min(6, studentNo.length - 4))}${studentNo.slice(-2)}`;
}

/** 姓名脱敏：保留姓，其余用 * 代替（复姓等极端情况按首字符处理） */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) {
    return '***';
  }
  const first = chars[0] ?? '';
  return `${first}${'*'.repeat(Math.max(1, chars.length - 1))}`;
}

/** 通用标识脱敏：保留首尾，用于日志中的 user_id、open_id 等 */
export function maskIdentifier(value: string, keepStart = 4, keepEnd = 4): string {
  if (value.length <= keepStart + keepEnd) {
    return '***';
  }
  return `${value.slice(0, keepStart)}***${value.slice(-keepEnd)}`;
}
