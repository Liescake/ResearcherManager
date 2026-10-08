import { Module } from '@nestjs/common';

/**
 * 同意、留存、更正、删除与归档流程 模块占位（阶段：P9）。
 * 当前不包含任何业务实现，仅声明模块边界，避免后续跨模块直接调用导致边界腐化。
 * 参考：docs/P2-架构与数据设计.md §2 服务模块边界。
 */
@Module({})
export class ComplianceModule {}
