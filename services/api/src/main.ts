import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_ENV } from './config/config.module';
import { describeEnv, type AppEnv } from './config/env';

/**
 * 启动装配（可测试）。
 *
 * 为什么把装配单独导出：`bootstrap` 是**不被导入的入口**，先前没有任何测试能覆盖
 * 「真实启动链路」——即 `NestFactory.create(AppModule)` → `app.init()`。而生产环境的
 * fail-closed 恰恰发生在这一段（未通过配置解析、或注入内存基线/未验证后端时装配直接失败）。
 * 导出一个函数后，测试可以走完全相同的装配路径（只替换配置来源），不启动监听端口、
 * 不连接任何数据库 —— 需要真实端口的用例再显式 `listen(0)`。
 *
 * 配置只有一个来源：**容器里的 `APP_ENV`**（`ConfigModule` 解析一次）。
 * 这一条很关键：应用自己 `loadEnv()` 出来的配置只能用于读取端口与日志，不能用来做判定，
 * 否则「应用实际使用的配置」与「判定用的配置」会漂移（判定通过、实际拿到别的值）。
 * 因此这里先 `init()`，再从容器取已校验配置。
 *
 * @param options.setGlobalPrefix 是否设置全局前缀（默认 true）。为 `false` 时保持 Nest 默认，
 *   便于用注入配置的测试装配走 HTTP 用例。
 * @param options.abortOnError 装配失败时是否走 Nest 默认的 `process.abort()`（默认 true，
 *   生产行为不变：进程直接终止，绝不带着坏配置继续跑）。测试传 `false` 以捕获并断言错误，
 *   否则在 worker 里无法观察失败原因（`process.abort()` 在 worker 中不可用）。
 */
export async function createApp(
  options: {
    readonly setGlobalPrefix?: boolean;
    readonly abortOnError?: boolean;
  } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    abortOnError: options.abortOnError ?? true,
  });

  // NestFactory.create 已完成实例化（生产环境的 fail-closed 主要在这里触发：配置解析、
  // 内存基线仓储拒绝构造）；init() 再触发 OnModuleInit / OnApplicationBootstrap，
  // 持久化边界守卫也在这时执行（实测日志可见其通过记录）。
  await app.init();

  const env = app.get<AppEnv>(APP_ENV);
  if (options.setGlobalPrefix !== false) {
    // Nest 的 setGlobalPrefix 不接受前导斜杠
    app.setGlobalPrefix(env.API_PREFIX.replace(/^\/+/u, ''));
  }
  app.enableShutdownHooks();
  return app;
}

/**
 * 启动流程：`createApp` 内解析并校验环境变量与配置（失败即抛错），再监听端口。
 * 生产环境缺少 / 非法 `DATABASE_URL`、对远端主机关闭 TLS，或在 `NODE_ENV=production` 下
 * 注入内存基线（含未验证 SQL 连接工厂）时，装配阶段直接失败：Nest 默认 `process.abort()`
 * 终止进程（子进程实测退出码 1），绝不带着坏配置继续跑。
 *
 * 门禁顺序（`startup-assembly.spec.ts` 守住）：配置解析 → 持久化能力声明 → SQL 执行器 attest
 * 契约，全部通过后才 `listen`。只要 `DATABASE_URL` 解析成功，无论 `NODE_ENV` 是什么，
 * 装配都必须提供经过 attest 且证据完整的 SQL 执行器，否则在**任何连接之前**终止启动。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await createApp();
  const env = app.get<AppEnv>(APP_ENV);

  await app.listen(env.API_PORT, env.API_HOST);

  logger.log(`服务已启动: http://${env.API_HOST}:${env.API_PORT}${env.API_PREFIX}`);
  logger.log(`健康检查: ${env.API_PREFIX}/health`);
  logger.log(`配置摘要: ${JSON.stringify(describeEnv(env))}`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
