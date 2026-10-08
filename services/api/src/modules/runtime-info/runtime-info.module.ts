import { Module } from '@nestjs/common';
import { RuntimeInfoController } from './runtime-info.controller';
import { RuntimeInfoService } from './runtime-info.service';

/**
 * 运维信息切片：只读 `APP_ENV`（由 @Global 的 ConfigModule 提供），不注册任何写入路由，
 * 也不改变既有路由（health 等）。
 */
@Module({
  controllers: [RuntimeInfoController],
  providers: [RuntimeInfoService],
})
export class RuntimeInfoModule {}
