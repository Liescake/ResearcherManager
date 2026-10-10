import { Controller, Get, Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import type { OperationalOutputProfile } from '../../common/operational-output';
import { checkOperationalOutput, describeOperationalIssues } from '../../common/operational-output';
import type { HealthPayload, ReadinessPayload } from './health.service';
import { HealthService } from './health.service';

/**
 * GET /api/v1/health        —— 存活与版本信息
 * GET /api/v1/health/ready  —— 依赖配置就绪情况（不返回任何密钥）
 *
 * 契约边界：两个响应在离开进程前必须满足**统一运维出口契约**
 * （`common/operational-output.ts`：闭集字段 + 取值级脱敏 + `ready ⇔ 全部 ok` 一致性）。
 * 该契约组合了两道既有判定：
 * 1. 结构契约 —— `health.openapi.yaml` 的运行时约束（经只读适配器
 *    `modules/ruoyi-adapter/contract/health-contract.ts` 提供）；
 * 2. 取值级脱敏门禁 —— `detail` 之类的自由文本里出现连接串、口令键值、SQL、内部路径、
 *    证据 ID、owner/user ID、provider 名称或堆栈帧一律拒绝。
 *
 * 违反契约属于服务端缺陷：返回 500，而不是把不合规数据当成正常输出发给调用方。
 * 校验只读取数据，不新增/删除/改名任何对外字段，也不改变任何路径。
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  /**
   * 显式 `@Inject`：当前两条转译链（`tsc` 构建、vitest 的 oxc 转译）都会生成
   * design:paramtypes，但该元数据取决于转译器的 emitDecoratorMetadata 支持
   * （实测：vitest 下为 ['HealthService']，而 esbuild 这一类路径不生成）。
   * 显式声明令牌后，依赖解析不再依赖类型元数据，生产与测试行为一致。
   */
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthPayload {
    return this.assertOperationalOutput('GET /health', 'health', this.healthService.getHealth());
  }

  @Get('ready')
  getReadiness(): ReadinessPayload {
    return this.assertOperationalOutput(
      'GET /health/ready',
      'readiness',
      this.healthService.getReadiness(),
    );
  }

  /**
   * 校验通过则原样返回（同一对象引用，字段与路径保持不变），否则抛 500。
   * 日志只写字段路径与违规类型，不写字段取值，避免把内部数据写进日志。
   */
  private assertOperationalOutput<T>(
    route: string,
    profile: OperationalOutputProfile,
    payload: T,
  ): T {
    const issues = checkOperationalOutput(profile, payload);
    if (issues.length === 0) {
      return payload;
    }

    this.logger.error(
      `[health-contract] ${route} 响应不符合运维出口契约: ${describeOperationalIssues(issues)}`,
    );
    throw new InternalServerErrorException('健康探针响应不符合 health 契约');
  }
}
