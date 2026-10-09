import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { DEMO_DATA_NOTICE } from '../api/demo-data';
import { ENDPOINTS } from '../api/endpoints';
import type { UiError } from '../api/errors';
import {
  SESSION_STORAGE_KEY,
  createDemoSession,
  createSession,
  serializeSession,
} from '../api/session';
import type { SessionStorageLike, SessionState } from '../api/session';
import { AsyncStateView } from '../components/AsyncStateView';
import type { Loadable } from '../state/async';

/**
 * 组件级测试：用 `react-dom/server` 静态渲染，**不引入 jsdom / Testing Library**。
 *
 * 取舍：静态渲染不执行 effect，因此这里断言的是「结构与状态分支」而不是交互；
 * 交互逻辑（守卫、分页、淘汰竞态）已经放在纯函数与网关里用 node 测试覆盖。
 * 好处是不新增任何依赖，也不需要浏览器环境即可在 CI 与受限沙箱里跑。
 */
const FORBIDDEN: UiError = {
  kind: 'forbidden',
  code: 'FORBIDDEN',
  message: '没有执行该操作的权限',
};
const UNAUTHORIZED: UiError = {
  kind: 'unauthorized',
  code: 'UNAUTHENTICATED',
  message: '会话失效',
};
const NOT_FOUND: UiError = { kind: 'not-found', code: 'NOT_FOUND', message: '目标资源不存在' };
const NETWORK: UiError = { kind: 'network', code: 'NETWORK_ERROR', message: '无法连接服务端' };

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

function memoryStorage(state: SessionState): SessionStorageLike {
  const data = new Map<string, string>();
  const serialized = serializeSession(state);
  if (serialized !== null) {
    data.set(SESSION_STORAGE_KEY, serialized);
  }
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('AsyncStateView 的六种状态', () => {
  const ready = <T,>(data: T): Loadable<T> => ({ status: 'ready', data });

  it('loading → 加载提示', () => {
    const html = render(
      <AsyncStateView
        state={{ status: 'loading' }}
        descriptor={ENDPOINTS.profileRead}
        label="本人画像"
      >
        {() => <span>内容</span>}
      </AsyncStateView>,
    );
    expect(html).toContain('正在加载本人画像');
  });

  it('ready → 渲染子内容', () => {
    const html = render(
      <AsyncStateView state={ready({ name: '张三' })} descriptor={ENDPOINTS.profileRead}>
        {(data) => <span>姓名：{data.name}</span>}
      </AsyncStateView>,
    );
    expect(html).toContain('姓名：张三');
  });

  it('ready 且为空 → 空态（即使有数据也不会被当成错误）', () => {
    const html = render(
      <AsyncStateView
        state={ready([] as string[])}
        descriptor={ENDPOINTS.adminApplications}
        isEmpty={(data) => data.length === 0}
        emptyTitle="当前没有申请记录"
      >
        {() => <span>表格</span>}
      </AsyncStateView>,
    );
    expect(html).toContain('当前没有申请记录');
    expect(html).not.toContain('表格');
  });

  it('403 在 stable 端点上显示无权限，并列出所需权限点', () => {
    const html = render(
      <AsyncStateView
        state={{ status: 'error', error: FORBIDDEN }}
        descriptor={{ ...ENDPOINTS.adminApplications, status: 'stable' as const }}
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(html).toContain('没有访问权限');
    expect(html).toContain('membership:review:group');
    expect(html).not.toContain('后端端点尚未实现');
  });

  it('403 在 pending 端点上解释为「端点尚未实现」，不与权限故障混淆', () => {
    const html = render(
      <AsyncStateView
        state={{ status: 'error', error: FORBIDDEN }}
        descriptor={{ ...ENDPOINTS.adminApplications, status: 'pending' as const }}
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(html).toContain('后端端点尚未实现');
    expect(html).toContain('GET /api/v1/admin/applications');
  });

  it('401 提示会话失效（跳转由会话层与守卫负责）', () => {
    const html = render(
      <AsyncStateView
        state={{ status: 'error', error: UNAUTHORIZED }}
        descriptor={ENDPOINTS.profileRead}
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(html).toContain('登录状态已失效');
    expect(html).toContain('正在返回登录页');
  });

  it('404 的语义由页面声明：empty 显示空态、pending 显示未实现', () => {
    const asEmpty = render(
      <AsyncStateView
        state={{ status: 'error', error: NOT_FOUND }}
        descriptor={ENDPOINTS.profileRead}
        notFound="empty"
        emptyTitle="尚未提交画像"
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(asEmpty).toContain('尚未提交画像');

    const asPending = render(
      <AsyncStateView
        state={{ status: 'error', error: NOT_FOUND }}
        descriptor={ENDPOINTS.adminApplications}
        notFound="pending"
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(asPending).toContain('后端端点尚未实现');
  });

  it('其它错误可重试，并暴露错误码与请求 ID 以便排障', () => {
    const html = render(
      <AsyncStateView
        state={{ status: 'error', error: { ...NETWORK, requestId: 'req-42' } }}
        descriptor={ENDPOINTS.health}
        onRetry={() => undefined}
      >
        {() => null}
      </AsyncStateView>,
    );
    expect(html).toContain('无法连接服务端');
    expect(html).toContain('NETWORK_ERROR');
    expect(html).toContain('req-42');
    expect(html).toContain('重试');
  });
});

describe('应用外壳的登录守卫与模式标注', () => {
  it('匿名访问受保护路由 → 只渲染跳转占位，不渲染受保护页面与导航', () => {
    const html = render(<App storage={null} />);
    expect(html).toContain('正在跳转');
    expect(html).not.toContain('个人资料');
    expect(html).not.toContain('统计概览');
  });

  it('联调模式 → 标注联调模式，不出现演示数据标注', () => {
    const storage = memoryStorage({
      status: 'authenticated',
      session: createSession('ticket-abcd1234', '会话票据登录'),
    });
    const html = render(<App storage={storage} />);
    expect(html).toContain('联调模式');
    expect(html).not.toContain(DEMO_DATA_NOTICE);
    expect(html).toContain('统计概览');
  });

  it('演示模式 → 常驻演示标注，且不宣称已连接后端', () => {
    const storage = memoryStorage({ status: 'authenticated', session: createDemoSession() });
    const html = render(<App storage={storage} />);
    expect(html).toContain('演示模式');
    expect(html).toContain(DEMO_DATA_NOTICE);
    expect(html).toContain('演示模式不发起请求');
  });
});
