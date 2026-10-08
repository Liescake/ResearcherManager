import { Controller, Get, Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import type { RuntimeInfoPayload } from './runtime-info.service';
import { RuntimeInfoService, checkRuntimeInfoFields } from './runtime-info.service';

/**
 * GET /api/v1/runtime-info —— 运行期配置摘要（只读、非敏感白名单）
 *
 * 字段闭集在离开进程前再校验一次：一旦有人把整份 env 展开进来（越界字段），
 * 或输出残缺（缺失字段），返回 500 而不是把不合规数据当作正常输出发给调用方。
 * 日志只写字段名与违规类型，不写字段取值。
 */
@Controller('runtime-info')
export class RuntimeInfoController {
  private readonly logger = new Logger(RuntimeInfoController.name);

  constructor(
    @Inject(RuntimeInfoService) private readonly runtimeInfoService: RuntimeInfoService,
  ) {}

  @Get()
  getRuntimeInfo(): RuntimeInfoPayload {
    const payload = this.runtimeInfoService.getRuntimeInfo();
    const issues = checkRuntimeInfoFields(payload);
    if (issues.length === 0) {
      return payload;
    }

    this.logger.error(
      `[runtime-info] 响应不符合字段白名单: ${issues
        .map((issue) => `${issue.field}(${issue.kind})`)
        .join(', ')}`,
    );
    throw new InternalServerErrorException('运维信息响应不符合字段白名单');
  }
}
