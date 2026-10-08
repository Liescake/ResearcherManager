import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env';

/** 环境配置注入令牌：只通过该令牌访问配置，禁止在业务代码里直接读 process.env */
export const APP_ENV = 'APP_ENV';

/**
 * 全局配置模块。
 * 使用 useFactory 在 Nest 启动阶段加载并校验环境变量（失败即启动失败）。
 */
@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv() }],
  exports: [APP_ENV],
})
export class ConfigModule {}
