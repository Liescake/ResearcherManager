import { readFileSync } from 'node:fs';
import { Pool, type PoolConfig } from 'pg';
import type {
  PoolClientLike,
  PoolLike,
  PostgresPoolFactory,
  PostgresPoolProfile,
} from './postgres-pool';

/**
 * **唯一 import `pg` 的文件**（`services/api/src/db/postgres/` 驱动层）。
 *
 * ## 为什么单独一层
 * 未装配切片时代，`postgres-adapter-registry.ts` 的门禁禁止任何地方 import `pg`；启用数据库
 * 之后这条规则不是被删掉，而是被**收窄**：`pg` 只允许出现在本目录。因此：
 * - `modules/**\/*.postgres-repository.ts` 仍然只能依赖驱动无关的 `SqlExecutor` 端口；
 * - 换驱动（或换 ORM）只需要改本文件，业务 adapter 与执行器契约都不动；
 * - 门禁可以在**目录粒度**上回答「驱动边界有没有被绕开」，而不是靠人工评审。
 *
 * ## 证书注入
 * `verify-full` 时按路径读取 CA / 客户端证书与私钥（路径来自环境变量，内容只存在于挂载卷）。
 * 仓库内不写证书（`.gitignore` 也排除 `*.pem` / `*.key`）；本文件只接受**绝对路径**。
 */
export const POSTGRES_DRIVER_PACKAGE = 'pg';

/** 驱动导入层目录（仓库相对、posix）：`pg` 只允许在本目录下被 import */
export const POSTGRES_DRIVER_LAYER_DIRECTORY = 'db/postgres/';

/** 由驱动层消费的机密片段（连接串里的口令）：用于错误脱敏，不进入任何产出对象 */
const SECRET_URL_PATTERN = /:\/\/([^:/?#@]+):([^@/?#]*)@/u;

/** 从连接串里取出用户口令（仅用于错误脱敏与驱动配置，绝不写日志） */
export function extractConnectionSecrets(connectionString: string): readonly string[] {
  const match = SECRET_URL_PATTERN.exec(connectionString);
  const password = match?.[2];
  return password === undefined || password === '' ? [] : [password];
}

/**
 * 把连接档案翻译成 `pg` 的池配置。
 *
 * 安全默认值：`rejectUnauthorized` 只在 `verify-full` 下为真；`require` 是「加密但不校验身份」，
 * 因此这里的 `rejectUnauthorized: false` **不是**可选项，而是该档位的定义 —— 生产环境由
 * `database-config.ts` 直接拒绝该档位，驱动层不需要再判一次。
 */
export function buildPoolConfig(profile: PostgresPoolProfile): PoolConfig {
  const ssl: PoolConfig['ssl'] =
    profile.ssl === 'disable'
      ? false
      : profile.ssl === 'verify-full'
        ? {
            rejectUnauthorized: true,
            ...(profile.tlsCaPath === undefined
              ? {}
              : { ca: readFileSync(profile.tlsCaPath, 'utf8') }),
            ...(profile.tlsCertPath === undefined
              ? {}
              : { cert: readFileSync(profile.tlsCertPath, 'utf8') }),
            ...(profile.tlsKeyPath === undefined
              ? {}
              : { key: readFileSync(profile.tlsKeyPath, 'utf8') }),
          }
        : { rejectUnauthorized: false };

  return {
    connectionString: profile.connectionString,
    application_name: profile.applicationName,
    max: profile.poolMax,
    connectionTimeoutMillis: profile.connectTimeoutMs,
    statement_timeout: profile.statementTimeoutMs,
    // 查询超时与语句超时同源：卡住的查询必须被驱动层主动断开，而不是无限占用连接
    query_timeout: profile.statementTimeoutMs,
    ssl,
  };
}

/** 真实池工厂：`pg.Pool` 的结构性包装（执行器只依赖 `PoolLike`） */
export function createNodePostgresPool(profile: PostgresPoolProfile): PoolLike {
  const pool = new Pool(buildPoolConfig(profile));
  return {
    async connect(): Promise<PoolClientLike> {
      const client = await pool.connect();
      return {
        query: (text, values) => client.query(text, values),
        release: (destroy) => client.release(destroy ?? false),
      };
    },
    query: (text, values) => pool.query(text, values),
    end: () => pool.end(),
  };
}

/** 默认池工厂（生产装配使用；测试注入替身即可脱离真实驱动） */
export const NODE_POSTGRES_POOL_FACTORY: PostgresPoolFactory = createNodePostgresPool;
