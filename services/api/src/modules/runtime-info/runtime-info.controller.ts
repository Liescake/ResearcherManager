import { Controller, Get, Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import { describeSensitiveFindings, findSensitiveOutput } from '../../common/sensitive-output';
import type { RuntimeInfoPayload } from './runtime-info.service';
import { RuntimeInfoService, checkRuntimeInfoFields } from './runtime-info.service';

/**
 * GET /api/v1/runtime-info —— 运行期配置摘要（只读、非敏感白名单）
 *
 * 字段闭集在离开进程前再校验一次：一旦有人把整份 env 展开进来（越界字段），
 * 或输出残缺（缺失字段），返回 500 而不是把不合规数据当作正常输出发给调用方。
 *
 * 除了字段名闭集，还要过一道**取值级脱敏门禁**（`common/sensitive-output.ts`）：
 * 运维信息里的持久化状态只能是脱敏事实（是否配置、布尔与枚举），出现连接串、口令键值、
 * SQL、内部路径或证据/连接配置字段名一律 500。日志只写字段名与违规类型，不写字段取值。
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
    const sensitive = findSensitiveOutput(payload);
    if (issues.length === 0 && sensitive.length === 0) {
      return payload;
    }

    const problems = [
      ...issues.map((issue) => `${issue.field}(${issue.kind})`),
      ...(sensitive.length === 0 ? [] : [`sensitive: ${describeSensitiveFindings(sensitive)}`]),
    ];
    this.logger.error(`[runtime-info] 响应不符合字段白名单/脱敏约束: ${problems.join(', ')}`);
    throw new InternalServerErrorException('运维信息响应不符合字段白名单');
  }
}
