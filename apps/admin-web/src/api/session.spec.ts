import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS,
  DEMO_SESSION_LABEL,
  SESSION_STORAGE_KEY,
  createBrowserSessionStorage,
  createDemoSession,
  createSession,
  isSessionTicketShape,
  parseSession,
  readSession,
  serializeSession,
  writeSession,
} from './session';
import type { SessionStorageLike } from './session';

function memoryStorage(initial: Record<string, string> = {}): SessionStorageLike & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('会话存储解析', () => {
  it('空值、坏 JSON、非对象一律判为匿名（默认拒绝）', () => {
    expect(parseSession(null)).toEqual(ANONYMOUS);
    expect(parseSession('')).toEqual(ANONYMOUS);
    expect(parseSession('不是 JSON')).toEqual(ANONYMOUS);
    expect(parseSession('"字符串"')).toEqual(ANONYMOUS);
    expect(parseSession('{"mode":"unknown"}')).toEqual(ANONYMOUS);
    expect(parseSession('{"mode":"real"}')).toEqual(ANONYMOUS);
  });

  it('票据形状受白名单约束，从结构上排除头注入', () => {
    expect(isSessionTicketShape('ticket-abcd1234')).toBe(true);
    expect(isSessionTicketShape('short')).toBe(false);
    expect(isSessionTicketShape('has\nnewline-1234')).toBe(false);
    expect(isSessionTicketShape('a'.repeat(129))).toBe(false);
    expect(isSessionTicketShape(12345678)).toBe(false);

    expect(parseSession(JSON.stringify({ mode: 'real', ticket: 'bad ticket!' }))).toEqual(
      ANONYMOUS,
    );
  });

  it('真实会话需要合法票据；演示会话不带票据', () => {
    const real = parseSession(
      JSON.stringify({ mode: 'real', ticket: 'ticket-abcd1234', label: '', signedInAt: '' }),
    );
    expect(real.status).toBe('authenticated');
    if (real.status === 'authenticated') {
      expect(real.session.mode).toBe('real');
      expect(real.session.label).toBe('会话票据登录');
    }

    const demo = parseSession(JSON.stringify({ mode: 'demo', label: DEMO_SESSION_LABEL }));
    expect(demo.status).toBe('authenticated');
    if (demo.status === 'authenticated') {
      expect(demo.session.mode).toBe('demo');
      expect('ticket' in demo.session).toBe(false);
    }
  });

  it('序列化 → 解析可往返；匿名序列化为 null', () => {
    const session = createSession('ticket-abcd1234', '联调');
    const state = { status: 'authenticated', session } as const;
    expect(parseSession(serializeSession(state))).toEqual(state);
    expect(serializeSession(ANONYMOUS)).toBeNull();
    expect(
      parseSession(serializeSession({ status: 'authenticated', session: createDemoSession() })),
    ).toMatchObject({ status: 'authenticated' });
  });
});

describe('会话读写', () => {
  it('写入后读回；匿名写入会删除键而不是写入空会话', () => {
    const storage = memoryStorage();
    writeSession(storage, {
      status: 'authenticated',
      session: createSession('ticket-abcd1234', 'x'),
    });
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(true);
    expect(readSession(storage).status).toBe('authenticated');

    writeSession(storage, ANONYMOUS);
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(readSession(storage)).toEqual(ANONYMOUS);
  });

  it('存储不可用（null）时不抛错，降级为匿名/不写入', () => {
    expect(readSession(null)).toEqual(ANONYMOUS);
    expect(() =>
      writeSession(null, { status: 'authenticated', session: createDemoSession() }),
    ).not.toThrow();
  });

  it('存储实现抛异常时被吞掉（隐私模式），不影响界面可用性', () => {
    const hostile: SessionStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSession(hostile)).toEqual(ANONYMOUS);
    expect(() =>
      writeSession(hostile, { status: 'authenticated', session: createDemoSession() }),
    ).not.toThrow();
    expect(() => writeSession(hostile, ANONYMOUS)).not.toThrow();
  });

  it('没有 window 时浏览器存储适配返回 null（SSR/测试环境）', () => {
    expect(createBrowserSessionStorage(undefined)).toBeNull();
  });
});
