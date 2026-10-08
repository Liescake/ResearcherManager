import { Module } from '@nestjs/common';

/**
 * 站内状态与订阅消息适配、失败重试 模块占位（阶段：P5）。
 * 当前不包含任何业务实现，仅声明模块边界，避免后续跨模块直接调用导致边界腐化。
 * 参考：docs/P2-架构与数据设计.md §2 服务模块边界。
 */
@Module({})
export class NotificationsModule {}
