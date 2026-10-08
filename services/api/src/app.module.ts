import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { ConfigModule } from './config/config.module';
import { DomainModulesModule } from './modules/domain-modules.module';
import { HealthModule } from './modules/health/health.module';
import { RuntimeInfoModule } from './modules/runtime-info/runtime-info.module';

/**
 * 应用根模块。
 * 全局响应信封与异常映射在此注册，业务模块不再各自处理响应格式。
 */
@Module({
  imports: [ConfigModule, HealthModule, RuntimeInfoModule, DomainModulesModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
