import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import {
  EXPORT_DOWNLOAD_CACHE_CONTROL,
  EXPORT_DOWNLOAD_NOSNIFF,
  buildExportDownloadDisposition,
} from './exports.contract';
import type { ExportRequestView } from './exports.contract';
import { ExportsService } from './exports.service';

/**
 * 下载响应的**最小响应面**：只声明本控制器真正用到的三个能力。
 * 刻意不引 `express` 类型：控制器无需绑定具体驱动，只需「能设置响应头、能结束响应」。
 */
export interface ExportDownloadResponseLike {
  setHeader(name: string, value: string): unknown;
  end(chunk: Uint8Array): unknown;
}

/**
 * 本人导出（学生自服务）：
 * - `GET  /api/v1/me/exports` 本人导出请求列表与状态；
 * - `POST /api/v1/me/exports` 创建本人的导出请求；
 * - `GET  /api/v1/me/exports/:exportId/download` 下载本人**已完成**导出的产物内容；
 * - `POST /api/v1/me/exports/:exportId/revoke` **撤销**本人的导出请求（撤销后下载立即统一 404）。
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「统计、导出、配置」的导出形态
 * （基线中的 `POST /admin/exports` 由 `resource` 决定原子权限、且下载与有效期另立路由，
 * 本切片按 `/me/...` 收敛到会话主体自身，落地**受理 + 状态 + 本人下载 + 本人撤销**；
 * 管理端导出、真实文件生成、异步产物清理不在本切片）。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`/`x-artifact-id`/
 *    `x-file-url` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于字段校验与任何端口调用**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参；
 * 3. `@Query()` 与 `@Body()` 原样交给 service，在授权之后判定：**列表端点只声明
 *    `cursor` / `limit` 两个查询参数**（其余一律 400），创建端点不接受任何查询参数、
 *    请求体只声明 `resource` / `fields`，撤销端点既不接受查询参数也不接受**任何**请求体字段，
 *    因此 `?userId=`/`?artifactId=`/`?fileUrl=`/`?path=` 与
 *    `{ userId, roles, scope, groupId, status, fileUrl, path }` 之类一律 400 `VALIDATION_FAILED`
 *    （给出可区分的拒绝原因），而不是静默忽略——客户端提交的归属、授权、状态与产物位置
 *    既不被读取，也不被信任。
 * 4. 下载与撤销路由的路径参数都只有 `exportId`（形态由 service 校验），**没有**任何可提交的
 *    产物位置入口；产物内容与两个响应头取值全部由 service 从服务端记录与常量派生，
 *    撤销的归属、结论与撤销时刻同样只来自服务端。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`；下载是唯一的例外：
 * 它必须交付**原始字节**（JSON 信封会把二进制内容 base64 化并破坏 `Content-Disposition`），
 * 因此该路由显式注入 `@Res()` 自行写响应，只在**全部校验通过之后**才设置响应头。
 * 异常路径仍由 `ApiExceptionFilter` 统一映射为稳定错误码（401/400/403/404/500）。
 */
@Controller('me/exports')
export class ExportsController {
  constructor(
    @Inject(ExportsService) private readonly exports: ExportsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  /**
   * 本人导出请求列表与状态（**键集分页**）。
   *
   * 查询串闭集只有 `cursor` / `limit` 两项（其余一律 400，见 service）；控制器**原样**把
   * `@Query()` 交给 service，不声明任何 DTO，也不读取任何自定义头 —— 因此客户端提交的
   * `userId` / `ownerUserId` / `artifactId` / `filePath` / `storageKey` 之类既不进入判定，
   * 也不会被「框架自动转换」成可用输入。
   *
   * 响应是共享信封 `{ data, meta, error }`：`data` 是既有 `ExportRequestView` 数组（**没有**
   * 任何新增字段，仍不含归属、产物句柄、路径与有效期），`meta` 只多出三项分页元数据
   * （`limit` / `hasNext` / `nextCursor`），`nextCursor` 是不透明签名串。
   */
  @Get()
  async listMyExportRequests(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ApiEnvelope<ExportRequestView[]>> {
    const result = await this.exports.listMyExportRequests(
      await requireSubject(this.sessions, authorization),
      query,
    );
    return ok(result.items, { ...result.page });
  }

  @Post()
  async createMyExportRequest(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ExportRequestView> {
    return this.exports.createMyExportRequest(
      await requireSubject(this.sessions, authorization),
      query,
      body,
    );
  }

  /**
   * 下载本人已完成的导出。
   *
   * 响应头只有在 service 返回（即归属、状态、授权、产物读取、硬上限、头取值全部通过）之后才设置，
   * 因此任何拒绝路径都不会出现 `Content-Disposition` 或任何内容字节：
   * - `content-type`：**固定**的服务端常量（不从存储或请求推导）；
   * - `content-disposition`：`attachment; filename="…"`，文件名由服务端摘要派生并再校验；
   * - `content-length`：内容字节数（内容由端口一次返回，因此长度在写出前已知）；
   * - `cache-control: no-store`：交付物不缓存；
   * - `x-content-type-options: nosniff`：禁止浏览器按内容嗅探类型。
   */
  @Get(':exportId/download')
  async downloadMyExport(
    @Headers('authorization') authorization: string | undefined,
    @Param('exportId') exportId: string,
    @Query() query: unknown,
    @Res() response: ExportDownloadResponseLike,
  ): Promise<void> {
    const download = await this.exports.downloadMyExport(
      await requireSubject(this.sessions, authorization),
      exportId,
      query,
    );

    response.setHeader('content-type', download.contentType);
    response.setHeader('content-disposition', buildExportDownloadDisposition(download.fileName));
    response.setHeader('content-length', String(download.bytes.byteLength));
    response.setHeader('cache-control', EXPORT_DOWNLOAD_CACHE_CONTROL);
    response.setHeader('x-content-type-options', EXPORT_DOWNLOAD_NOSNIFF);
    response.end(Buffer.from(download.bytes));
  }

  /**
   * **撤销本人导出请求**（`POST /me/exports/:exportId/revoke`）。
   *
   * - 显式 `@HttpCode(200)`：撤销是**幂等动作**（重复请求同样 200，结果都是「该导出已撤销」），
   *   不是一次资源创建，因此不使用 Nest 对 `POST` 的 201 默认值；成功、幂等重复都返回
   *   同一个 200 + 既有 `ExportRequestView` 闭集（已撤销时 `status` 呈现为 `revoked`）；
   * - `@Body()` 原样交给 service：撤销端点的请求体闭集是**空集**（任何字段都 400），
   *   因此客户端提交的 `userId` / `ownerId` / `artifactId` / `path` / `status` / `revokedAt`
   *   既不被读取、也不被信任；
   * - `@Query()` 原样交给 service：撤销端点不接受任何查询参数（其余一律 400）；
   * - 控制器不注入 `@Res()`：撤销返回的是普通 JSON 信封，不是字节流。
   */
  @Post(':exportId/revoke')
  @HttpCode(200)
  async revokeMyExportRequest(
    @Headers('authorization') authorization: string | undefined,
    @Param('exportId') exportId: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ExportRequestView> {
    return this.exports.revokeMyExportRequest(
      await requireSubject(this.sessions, authorization),
      exportId,
      query,
      body,
    );
  }
}
