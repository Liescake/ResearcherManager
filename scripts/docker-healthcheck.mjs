#!/usr/bin/env node
/**
 * 容器健康探针（公开、零依赖，只用 `node:` 内置模块）。
 *
 * 为什么单独抽成一个脚本，而不是在 `Dockerfile` 与 `docker-compose.yml` 里各写一段
 * `node -e "..."`：
 * - 两处内联脚本会各自漂移（本次实际发生：镜像健康检查硬编码 `/api/v1/health`，而 compose
 *   里没有 api 健康检查），抽成文件后**同一份探针**同时被镜像 `HEALTHCHECK`、Compose
 *   `healthcheck` 和本机自测复用；
 * - 探针路径必须跟随 `API_PREFIX`（全局前缀是运行时配置），不能再硬编码。
 *
 * 判定（fail-closed，退出码语义与 Docker/K8s 探针兼容）：
 *   0 = `GET <API_PREFIX>/health` 返回 200
 *   1 = 连接失败 / 超时 / 非 200 / 响应体不是本项目统一信封
 *
 * 只读探针：不发送任何凭据、不写文件、不打印任何环境变量取值（避免把密钥写进容器日志）。
 *
 * 覆盖项（便于自测与容器内固定路径调用）：
 *   API_HEALTHCHECK_HOST  默认 127.0.0.1
 *   API_HEALTHCHECK_PORT  默认 API_PORT，再默认 3000
 *   API_HEALTHCHECK_PATH  默认 <API_PREFIX>/health，API_PREFIX 默认 /api/v1
 */

import { get } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_PREFIX = '/api/v1';
const TIMEOUT_MS = 3000;

/** 拼接健康检查路径：前缀统一去掉尾部斜杠，避免 `//health` */
function resolvePath(env) {
  const explicit = (env.API_HEALTHCHECK_PATH ?? '').trim();
  if (explicit !== '') {
    return explicit.startsWith('/') ? explicit : `/${explicit}`;
  }
  const prefix = (env.API_PREFIX ?? DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
  return `${prefix.replace(/\/+$/u, '')}/health`;
}

/** 解析端口：非法值直接按「探针不可用」处理，不做静默兜底 */
function resolvePort(env) {
  const raw = (env.API_HEALTHCHECK_PORT ?? env.API_PORT ?? '').trim();
  if (raw === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }
  return parsed;
}

/**
 * 探测一次。
 * 返回 `{ ok, detail }`：`detail` 只含状态码与原因，绝不含环境变量取值。
 */
export function probe(env = process.env, timeoutMs = TIMEOUT_MS) {
  const host = (env.API_HEALTHCHECK_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = resolvePort(env);
  if (port === null) {
    return Promise.resolve({ ok: false, detail: 'API_PORT / API_HEALTHCHECK_PORT 不是合法端口' });
  }
  const path = resolvePath(env);

  return new Promise((resolve) => {
    const request = get({ host, port, path, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.on('end', () => {
        resolve({
          ok: status === 200,
          detail: `GET ${path} -> HTTP ${status}`,
        });
      });
    });
    request.on('error', (error) => {
      // 只报错误类型名：错误消息可能带上主机/端口之外的内部细节
      resolve({ ok: false, detail: `GET ${path} -> 连接错误 ${error.code ?? error.name}` });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, detail: `GET ${path} -> 超时（${timeoutMs}ms）` });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = await probe();
  if (result.ok) {
    process.stdout.write(`healthy: ${result.detail}\n`);
    process.exit(0);
  }
  process.stderr.write(`unhealthy: ${result.detail}\n`);
  process.exit(1);
}
