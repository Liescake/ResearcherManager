import { PayloadTooLargeException } from '@nestjs/common';
import type { NextFunctionLike } from './security-headers';

/**
 * 请求体大小上限（认证 / DoS 审计 BLOCK 项的修复点）。
 *
 * 为什么必须**显式**配置：不配置时，解析上限来自 body-parser 的隐式默认值 —— json 与
 * urlencoded 都是 `100kb`，而 Nest 更是把 urlencoded 硬编码成 `extended: true`
 * （@nestjs/platform-express `express-adapter.js` 的 `registerParserMiddleware()`：
 * `express.urlencoded(getBodyParserOptions(rawBody, { extended: true }))`）。
 * 这两条都有问题：
 * 1. 隐式默认值随依赖版本漂移，安全边界不能建立在他人的默认值上；
 * 2. `extended: true` 走 `qs` 的**嵌套**解析：攻击者可以用很小的字节数构造极深的
 *    `a[b][c][d]…` 嵌套，在**认证之前**（解析器是全局中间件，先于路由与守卫）就消耗掉
 *    解析期的 CPU 与内存。改成 `extended: false` 后按 `querystring` 语义解析，键名保持原样、
 *    不构造嵌套对象，且 `parameterLimit` 仍限制参数个数。
 *
 * 因此这里把两个上限**写死成常量**并显式注册：JSON 100kb、表单 20kb 且 `extended: false`。
 * 不提供环境变量开关：这是 fail-closed 的加固下限，不能靠改配置放宽；要调整必须改代码并复核。
 * 也不引入新依赖：`useBodyParser()` 是 @nestjs/platform-express 既有能力（Express 适配器）。
 *
 * 与之配套，`main.ts` 用 `{ bodyParser: false }` 关掉 Nest 的默认解析器注册：默认解析器一旦
 * 同时存在，实际生效的上限就取决于两套中间件的先后与「请求流是否已被读完」这类框架内部细节。
 * 由本模块**独占**解析栈后，「应用实际使用的上限」与「这里声明的上限」不可能再漂移。
 *
 * 装配顺序（见 `main.ts` 的调用位置）有两条硬性要求：
 * 1. 必须在 `app.init()` **之前**注册：init() 会注册路由，中间件顺序即注册顺序；
 * 2. 必须在安全响应头**之后**注册：Express 的错误中间件只能接住注册在它之前的层产生的错误，
 *    先挂安全头，解析器直接拒绝的 413 响应才会同样带上安全头。
 */

/** JSON 请求体上限：100kb（`bytes` 语义，即 102400 字节） */
export const JSON_BODY_LIMIT = '100kb';

/**
 * 表单请求体上限：20kb（即 20480 字节）。
 * 比 JSON 更紧是因为本 API 的契约里没有「大表单」这种入参形态：表单只可能来自非浏览器客户端，
 * 正常体积远小于 20kb；把它收紧到最小可用值可以直接缩小解析期的攻击面。
 */
export const URLENCODED_BODY_LIMIT = '20kb';

/**
 * 表单解析必须关闭嵌套解析（`extended: false`）。
 * 单列成常量是为了让测试能断言这个值本身，而不是只断言「有没有传 extended」。
 */
export const URLENCODED_EXTENDED = false;

/**
 * 本模块只需要应用对象的这两个能力（便于单测用假对象断言「到底配了什么」，不启动真实应用）。
 * 真实对象是 `NestExpressApplication`：`useBodyParser` 来自 @nestjs/platform-express，
 * `use` 来自 `INestApplication`。
 */
export interface RequestBodyLimitApplication {
  readonly useBodyParser: (
    parser: 'json' | 'urlencoded',
    options?: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly use: (...args: readonly unknown[]) => unknown;
}

/**
 * 把「请求体上限」装配到应用上（`createApp` 的装配步骤之一，必须早于 `app.init()`）。
 * 返回实际注册的解析选项，便于调用方 / 测试断言「装了什么」。
 */
export function applyRequestBodyLimits(
  app: RequestBodyLimitApplication,
): readonly Readonly<Record<string, unknown>>[] {
  const jsonOptions = Object.freeze({ limit: JSON_BODY_LIMIT });
  const urlencodedOptions = Object.freeze({
    limit: URLENCODED_BODY_LIMIT,
    extended: URLENCODED_EXTENDED,
  });

  app.useBodyParser('json', jsonOptions);
  app.useBodyParser('urlencoded', urlencodedOptions);

  // 错误翻译必须注册在两个解析器**之后**：Express 的错误中间件只接收注册位置之前产生的错误。
  app.use(createBodyParserErrorTranslator());

  return [jsonOptions, urlencodedOptions];
}

/** body-parser 用来标记「请求体超过上限」的错误类型（2.x 与 1.x 同名） */
const ENTITY_TOO_LARGE = 'entity.too.large';

/**
 * 把 body-parser 的「请求体过大」错误翻译成 Nest 的 `PayloadTooLargeException`。
 *
 * 为什么需要这一步：body-parser 抛出的不是 `HttpException`，而 Nest 的
 * `RoutesResolver.mapExternalException()` 只包装 `SyntaxError` / `URIError` / Fastify 错误，
 * 其余原样交给异常过滤器 —— 于是「请求体过大」会落进 `ApiExceptionFilter` 的兜底分支变成
 * **500 INTERNAL_ERROR**（改动前实测：300kb JSON → 500），既丢失 413 这个语义正确的状态码，
 * 也误导客户端（500 看起来是服务端故障、值得重试；413 才表示请求本身太大、必须改小）。
 *
 * 只翻译 `entity.too.large` 一类，其余错误（含 `entity.parse.failed`）原样透传：那些错误已经有
 * 既定出口（SyntaxError 由 Nest 包装成 400，且过滤器会抹掉回显请求体的消息），不在这里重复处理。
 *
 * 对外文案用 Nest 的标准文案（`Payload Too Large`），**不回显**原始错误消息里的
 * limit/长度细节，也不带任何请求体内容。
 */
export function translateBodyParserError(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ((error as { type?: unknown }).type !== ENTITY_TOO_LARGE) {
    return undefined;
  }
  return new PayloadTooLargeException();
}

/**
 * 生成「解析器错误翻译」中间件。
 *
 * 必须是**四参**函数：Express 以函数元数（arity）区分普通中间件与错误中间件，三参函数不会
 * 被调用（`request-body-limits.spec.ts` 断言 `length === 4`）。非 translator 认识的
 * 错误一律原样 `next(error)`，不吞异常、不改语义。
 */
export function createBodyParserErrorTranslator(): (
  error: unknown,
  request: unknown,
  response: unknown,
  next: NextFunctionLike,
) => void {
  return (error, _request, _response, next) => {
    next(translateBodyParserError(error) ?? error);
  };
}
