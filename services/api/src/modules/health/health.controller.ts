import { Controller, Get, Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import type { HealthContractIssue } from '../ruoyi-adapter/contract/health-contract';
import {
  checkHealthDataAgainstContract,
  checkReadinessDataAgainstContract,
  expectedReadinessStatus,
} from '../ruoyi-adapter/contract/health-contract';
import type { HealthPayload, ReadinessPayload } from './health.service';
import { HealthService } from './health.service';

/**
 * GET /api/v1/health        —— 存活与版本信息
 * GET /api/v1/health/ready  —— 依赖配置就绪情况（不返回任何密钥）
 *
 * 契约边界：两个响应的业务数据在离开进程前必须满足 health.openapi.yaml 的运行时约束
 * （`modules/ruoyi-adapter/contract/health-contract.ts` 是同一契约的只读适配器）。
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
    return this.assertContract('GET /health', this.healthService.getHealth(), (payload) =>
      checkHealthDataAgainstContract(payload),
    );
  }

  @Get('ready')
  getReadiness(): ReadinessPayload {
    return this.assertContract(
      'GET /health/ready',
      this.healthService.getReadiness(),
      (payload) => {
        const issues = checkReadinessDataAgainstContract(payload);
        // 契约 §6：ready ⇔ 全部检查项为 ok。字段级校验无法发现「status 与 checks 不一致」，
        // 而这种数据同样会让调用方做出错误决策，因此只在结构合法时补一条一致性判定。
        if (issues.length === 0 && payload.status !== expectedReadinessStatus(payload.checks)) {
          issues.push({
            kind: 'invalid',
            path: 'data.status',
            message: 'status 必须与 checks 一致（ready ⇔ 全部检查项为 ok）',
          });
        }
        return issues;
      },
    );
  }

  /**
   * 校验通过则原样返回（同一对象引用，字段与路径保持不变），否则抛 500。
   * 日志只写字段路径与违规类型，不写字段取值，避免把内部数据写进日志。
   */
  private assertContract<T>(
    route: string,
    payload: T,
    check: (payload: T) => HealthContractIssue[],
  ): T {
    const issues = check(payload);
    if (issues.length === 0) {
      return payload;
    }

    this.logger.error(
      `[health-contract] ${route} 响应不符合契约: ${issues
        .map((issue) => `${issue.path}(${issue.kind})`)
        .join(', ')}`,
    );
    throw new InternalServerErrorException('健康探针响应不符合 health 契约');
  }
}
