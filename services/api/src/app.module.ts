import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { DomainModulesModule } from './modules/domain-modules.module';
import { HealthModule } from './modules/health/health.module';
import { RuntimeInfoModule } from './modules/runtime-info/runtime-info.module';

/**
 * 应用根模块。
 * 全局响应信封与异常映射在此注册，业务模块不再各自处理响应格式。
 *
 * `DatabaseModule` 只提供共享数据库配置、fail-closed 的 SQL 连接工厂与启动期持久化边界检查，
 * **不换绑任何业务 repository**：当前运行时仍是内存基线，生产环境由边界检查拒绝启动。
 */
@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule, RuntimeInfoModule, DomainModulesModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
