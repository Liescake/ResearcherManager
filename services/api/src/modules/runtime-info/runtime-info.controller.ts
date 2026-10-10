import { Controller, Get, Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import { checkOperationalOutput, describeOperationalIssues } from '../../common/operational-output';
import type { RuntimeInfoPayload } from './runtime-info.service';
import { RuntimeInfoService } from './runtime-info.service';

/**
 * GET /api/v1/runtime-info —— 运行期配置摘要（只读、非敏感白名单）
 *
 * 出口在离开进程前必须满足**统一运维出口契约**（`common/operational-output.ts`）：
 * 1. 字段闭集 —— 恰好 `RUNTIME_INFO_FIELDS` 的 7 个字段，多一个少一个都不行
 *    （一旦有人把整份 env 展开进来，或输出残缺，返回 500 而不是把不合规数据发出去）；
 * 2. 取值级脱敏 —— 白名单字段里塞进连接串、口令键值、SQL、内部路径、证据 ID、
 *    owner/user ID、provider 名称或堆栈帧同样 500。
 *
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
    const issues = checkOperationalOutput('runtimeInfo', payload);
    if (issues.length === 0) {
      return payload;
    }

    this.logger.error(
      `[runtime-info] 响应不符合运维出口契约: ${describeOperationalIssues(issues)}`,
    );
    throw new InternalServerErrorException('运维信息响应不符合字段白名单');
  }
}
