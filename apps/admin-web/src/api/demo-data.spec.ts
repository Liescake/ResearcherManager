import {
  APPLICATION_STATUS_VALUES,
  isApplicationKind,
  isApplicationStatus,
  isAvailablePeriod,
  isGrade,
  isProgrammingLevel,
  isReviewStatus,
  computeAdmissionRate,
} from '@rm/shared';
import { describe, expect, it } from 'vitest';
import {
  DEMO_ADMIN_STATISTICS,
  DEMO_APPLICATIONS,
  DEMO_EDUCATION_RECORDS,
  DEMO_NOTIFICATIONS,
  DEMO_PROFILE,
  DEMO_SELF_STATISTICS,
  buildDemoApplicationPage,
  demoNotificationItems,
} from './demo-data';
import { ADMIN_STATISTICS_SOURCES, NOTIFICATION_STATUS_VALUES } from './types';

describe('演示夹具与共享契约保持一致', () => {
  it('申请条目的枚举取值都在共享闭集内', () => {
    expect(DEMO_APPLICATIONS.length).toBeGreaterThan(0);
    for (const item of DEMO_APPLICATIONS) {
      expect(isApplicationStatus(item.status)).toBe(true);
      expect(isApplicationKind(item.kind)).toBe(true);
      expect(isReviewStatus(item.reviewStatus)).toBe(true);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      expect(item.id.length).toBeGreaterThan(0);
    }
  });

  it('画像枚举与时间戳合法', () => {
    expect(isGrade(DEMO_PROFILE.grade)).toBe(true);
    expect(isProgrammingLevel(DEMO_PROFILE.programmingLevel)).toBe(true);
    for (const period of DEMO_PROFILE.availableTime.periods) {
      expect(isAvailablePeriod(period)).toBe(true);
    }
    expect(Number.isNaN(Date.parse(DEMO_PROFILE.updatedAt))).toBe(false);
  });

  it('统计计数是非负整数（0 是合法事实）', () => {
    for (const value of Object.values(DEMO_SELF_STATISTICS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('管理端统计覆盖契约基线的三个来源，且每项指标都有 key/label', () => {
    for (const source of ADMIN_STATISTICS_SOURCES) {
      const metrics = DEMO_ADMIN_STATISTICS[source];
      expect(metrics).toBeDefined();
      expect((metrics ?? []).length).toBeGreaterThan(0);
      for (const metric of metrics ?? []) {
        expect(metric.key.length).toBeGreaterThan(0);
        expect(metric.label.length).toBeGreaterThan(0);
        expect(Number.isInteger(metric.value)).toBe(true);
      }
    }
  });

  it('升学夹具可按共享口径算出升学率（前端不自行推导公式）', () => {
    const result = computeAdmissionRate(DEMO_EDUCATION_RECORDS);
    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(3);
    expect(result.excludedPreparing).toBe(1);
    expect(result.excludedNotApproved).toBe(1);
    expect(result.rate).toBeCloseTo(2 / 3, 5);
  });

  it('通知夹具只含服务端白名单字段：状态在闭集内、已读必带 readAt，且不含归属 / 渠道', () => {
    expect(DEMO_NOTIFICATIONS.length).toBeGreaterThan(0);
    const allowed = ['body', 'createdAt', 'id', 'readAt', 'status', 'title', 'type', 'updatedAt'];
    for (const item of DEMO_NOTIFICATIONS) {
      expect(NOTIFICATION_STATUS_VALUES).toContain(item.status);
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false);
      if (item.status === 'read') {
        expect(item.readAt).toBeDefined();
        expect(Number.isNaN(Date.parse(item.readAt ?? ''))).toBe(false);
      } else {
        expect(item.readAt).toBeUndefined();
      }
      // 归属、会话票据、深链路径、投递渠道都不是接口视图字段，夹具里也不许出现
      for (const key of Object.keys(item)) {
        expect(allowed).toContain(key);
      }
    }
  });

  it('通知夹具返回副本：就地修改不污染夹具', () => {
    const items = demoNotificationItems();
    const first = items[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      first.title = '被就地修改';
    }
    expect(DEMO_NOTIFICATIONS[0]?.title).not.toBe('被就地修改');
  });
});

describe('演示分页与后端语义同构', () => {
  it('分页从 1 开始，totalPages 与 total 一致', () => {
    const first = buildDemoApplicationPage({ page: 1, pageSize: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.total).toBe(DEMO_APPLICATIONS.length);
    expect(first.totalPages).toBe(Math.ceil(DEMO_APPLICATIONS.length / 3));
    expect(first.page).toBe(1);

    const last = buildDemoApplicationPage({
      page: first.totalPages ?? 1,
      pageSize: 3,
    });
    expect(last.items.length).toBeGreaterThan(0);
    expect(last.items.length).toBeLessThanOrEqual(3);
  });

  it('超出范围的页返回空集而不是抛错，且 totalPages 为 0 表示空表', () => {
    const beyond = buildDemoApplicationPage({ page: 99, pageSize: 20 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(DEMO_APPLICATIONS.length);

    const none = buildDemoApplicationPage({ page: 1, pageSize: 20, keyword: '不存在的关键词' });
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.totalPages).toBe(0);
  });

  it('按状态过滤与关键词过滤都作用在服务端口径（不是前端二次裁剪）', () => {
    const pending = buildDemoApplicationPage({
      page: 1,
      pageSize: 20,
      status: APPLICATION_STATUS_VALUES[0],
    });
    expect(pending.total).toBe(
      DEMO_APPLICATIONS.filter((item) => item.status === APPLICATION_STATUS_VALUES[0]).length,
    );
    expect(pending.items.every((item) => item.status === APPLICATION_STATUS_VALUES[0])).toBe(true);

    const byGroup = buildDemoApplicationPage({ page: 1, pageSize: 20, keyword: '演示科研小组 2' });
    expect(byGroup.total).toBe(3);
  });

  it('返回的是副本：修改返回值不会污染夹具（避免跨页面状态串味）', () => {
    const page = buildDemoApplicationPage({ page: 1, pageSize: 1 });
    const first = page.items[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      first.note = '被就地修改';
    }
    expect(DEMO_APPLICATIONS[0]?.note).not.toBe('被就地修改');
  });
});
