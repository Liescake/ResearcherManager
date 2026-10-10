import { HttpException } from '@nestjs/common';
import { MAX_PAGE_SIZE, paginationSchema } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import {
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
  URLENCODED_EXTENDED,
  applyRequestBodyLimits,
  createBodyParserErrorTranslator,
  translateBodyParserError,
  type RequestBodyLimitApplication,
} from './request-body-limits';

/**
 * 请求体上限装配的**单元面**。
 *
 * 真实 HTTP 行为（超限被拒 413、合法边界仍正常）由 `startup-assembly.spec.ts` 的
 * 「请求体大小上限」用例在真实 `createApp()` + 真实 `listen` 上守住。这里用**假应用对象**钉住
 * 真实 HTTP 用例观察不到、或只能间接观察的部分：
 * 1. 上限的**具体取值**（100kb / 20kb）与 `extended: false` 本身；
 * 2. 注册的**顺序与数量**（两个解析器 + 恰好一个错误翻译中间件，且翻译器在解析器之后）；
 * 3. 错误翻译的**四参形态**与「只翻译 entity.too.large、其余原样透传」的边界。
 */

type RecordedCall =
  | {
      readonly kind: 'parser';
      readonly parser: string;
      readonly options?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'middleware'; readonly handler: unknown };

/** 只实现本模块用到的两个能力，并按下标记录调用顺序（顺序本身是被测语义的一部分） */
function createFakeApp(): { app: RequestBodyLimitApplication; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const app: RequestBodyLimitApplication = {
    useBodyParser: (parser, options) => {
      calls.push({ kind: 'parser', parser, ...(options ? { options } : {}) });
    },
    use: (...args) => {
      for (const handler of args) {
        calls.push({ kind: 'middleware', handler });
      }
    },
  };
  return { app, calls };
}

describe('请求体大小上限：取值固定，不随环境与依赖默认值漂移', () => {
  it('上限是写死的常量：JSON 100kb、表单 20kb 且 extended:false', () => {
    expect(JSON_BODY_LIMIT).toBe('100kb');
    expect(URLENCODED_BODY_LIMIT).toBe('20kb');
    // 表单必须关闭嵌套解析（qs 深嵌套是解析期的 CPU/内存放大面）
    expect(URLENCODED_EXTENDED).toBe(false);
  });

  it('装配顺序与内容：先注册两个解析器，再注册错误翻译中间件', () => {
    const { app, calls } = createFakeApp();

    const registered = applyRequestBodyLimits(app);

    // 顺序：json → urlencoded → 错误中间件。翻译器若排在解析器之前，Express 根本不会调用它
    expect(calls.map((call) => call.kind)).toEqual(['parser', 'parser', 'middleware']);

    const [jsonCall, urlencodedCall] = calls as [
      Extract<RecordedCall, { kind: 'parser' }>,
      Extract<RecordedCall, { kind: 'parser' }>,
    ];
    expect(jsonCall.parser).toBe('json');
    expect(jsonCall.options).toEqual({ limit: '100kb' });
    expect(urlencodedCall.parser).toBe('urlencoded');
    expect(urlencodedCall.options).toEqual({ limit: '20kb', extended: false });

    // 返回值与真实注册值一致（调用方/测试据此断言「装了什么」，不能出现两份真相）
    expect(registered).toEqual([{ limit: '100kb' }, { limit: '20kb', extended: false }]);

    // 只注册这两个解析器：不再由 Nest 注册默认解析器（`bodyParser: false`），也不放开 text/raw
    expect(calls.filter((call) => call.kind === 'parser')).toHaveLength(2);

    // 错误中间件必须是四参函数：Express 以函数元数区分错误中间件，三参函数不会被调用
    const middlewareCall = calls[2] as Extract<RecordedCall, { kind: 'middleware' }>;
    expect(typeof middlewareCall.handler).toBe('function');
    expect((middlewareCall.handler as (...args: unknown[]) => unknown).length).toBe(4);
  });
});

describe('请求体上限：超限错误的翻译边界', () => {
  it('只把 entity.too.large 翻译成 413，其余错误原样透传', () => {
    const translated = translateBodyParserError({
      type: 'entity.too.large',
      // body-parser 原始消息里带 limit/长度细节：这些**不得**出现在对外响应里
      message: 'request entity too large',
      limit: 102400,
    });

    expect(translated).toBeInstanceOf(HttpException);
    expect((translated as HttpException).getStatus()).toBe(413);
    const serialized = JSON.stringify((translated as HttpException).getResponse());
    expect(serialized).not.toMatch(/102400|100kb|20kb|entity\.too\.large/iu);

    // 其他类型既不翻译也不吞掉：JSON 语法错误走既定出口（Nest 包装成 400 + 过滤器抹掉回显）
    expect(translateBodyParserError({ type: 'entity.parse.failed' })).toBeUndefined();
    expect(
      translateBodyParserError(new SyntaxError('Unexpected end of JSON input')),
    ).toBeUndefined();
    expect(translateBodyParserError(undefined)).toBeUndefined();
    expect(translateBodyParserError(null)).toBeUndefined();
    expect(translateBodyParserError('entity.too.large')).toBeUndefined();
  });

  it('错误中间件：翻译超限错误，其余错误（含无错误）原样继续链路', () => {
    const handler = createBodyParserErrorTranslator();
    const forwarded: unknown[] = [];
    const next = (error?: unknown): void => {
      forwarded.push(error);
    };

    handler({ type: 'entity.too.large' }, {}, {}, next);
    const passthrough = new Error('boom');
    handler(passthrough, {}, {}, next);
    handler(undefined, {}, {}, next);

    expect(forwarded[0]).toBeInstanceOf(HttpException);
    expect((forwarded[0] as HttpException).getStatus()).toBe(413);
    // 非超限错误必须原样（同一个对象）交给后续中间件：既不吞异常，也不改语义
    expect(forwarded[1]).toBe(passthrough);
    expect(forwarded[2]).toBeUndefined();
  });
});

/**
 * 分页/查询上限的**反放宽**守卫。
 *
 * 本次改动只碰请求体解析，但解析栈是全局中间件，最容易被顺手改宽的就是「上限」这类常量。
 * 这里把服务端分页上限钉在共享 schema 上：`pageSize` 恰好等于上限可用，超过上限必须被拒。
 */
describe('请求体上限改动不放宽查询/分页限制', () => {
  it('pageSize 仍受 MAX_PAGE_SIZE 约束（等于上限通过、超过上限拒绝）', () => {
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(paginationSchema.safeParse({ pageSize: MAX_PAGE_SIZE }).success).toBe(true);
    expect(paginationSchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    // 下界同样没有被放宽（0 与负数仍然非法）
    expect(paginationSchema.safeParse({ pageSize: 0 }).success).toBe(false);
  });
});
