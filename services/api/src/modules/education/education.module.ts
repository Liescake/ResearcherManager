import { Module } from '@nestjs/common';

/**
 * 升学记录、审核与统计口径 模块占位（阶段：P5/P6）。
 * 当前不包含任何业务实现，仅声明模块边界，避免后续跨模块直接调用导致边界腐化。
 * 参考：docs/P2-架构与数据设计.md §2 服务模块边界。
 */
@Module({})
export class EducationModule {}
