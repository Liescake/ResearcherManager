import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { describeEnv, loadEnv } from './config/env';

/**
 * 启动流程：先校验环境变量（失败即退出），再创建应用。
 * 注意：全局前缀来自 API_PREFIX（默认 /api/v1），与 docs/P2-API契约基线.md 一致。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Nest 的 setGlobalPrefix 不接受前导斜杠
  app.setGlobalPrefix(env.API_PREFIX.replace(/^\/+/u, ''));
  app.enableShutdownHooks();

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
