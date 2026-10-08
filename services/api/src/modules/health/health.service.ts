import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';

/** 保持与 services/api/package.json 的 version 一致 */
export const SERVICE_NAME = 'researcher-manager-api';
export const SERVICE_VERSION = '0.1.0';

export interface HealthPayload {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  prefix: string;
}

export type ReadinessCheckStatus = 'ok' | 'not_configured' | 'degraded';

export interface ReadinessCheck {
  name: string;
  status: ReadinessCheckStatus;
  detail?: string;
}

export interface ReadinessPayload {
  status: 'ready' | 'degraded';
  checks: ReadinessCheck[];
}

/**
 * 健康检查：只暴露运行状态与配置开关，不泄露连接串、密钥或内部地址。
 * P3 骨架允许「无数据库可启动」，因此缺少 DATABASE_URL 记为 degraded 而不是失败。
 */
@Injectable()
export class HealthService {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  getHealth(now: Date = new Date()): HealthPayload {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: now.toISOString(),
      prefix: this.env.API_PREFIX,
    };
  }

  getReadiness(): ReadinessPayload {
    const checks: ReadinessCheck[] = [
      this.env.DATABASE_URL
        ? { name: 'database', status: 'ok' }
        : {
            name: 'database',
            status: 'not_configured',
            detail: '未配置 DATABASE_URL：P3 骨架允许无数据库启动，业务接口尚未实现',
          },
      this.env.SESSION_SECRET
        ? { name: 'sessionSecret', status: 'ok' }
        : { name: 'sessionSecret', status: 'not_configured', detail: '未配置 SESSION_SECRET' },
      this.env.AI_PROVIDER === 'disabled' || !this.env.AI_MATCHING_ENABLED
        ? { name: 'aiMatching', status: 'degraded', detail: 'AI 匹配未启用，走规则降级' }
        : { name: 'aiMatching', status: 'ok' },
    ];

    return {
      status: checks.some((check) => check.status !== 'ok') ? 'degraded' : 'ready',
      checks,
    };
  }
}
