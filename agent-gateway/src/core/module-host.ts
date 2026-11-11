/**
 * 模块宿主管理器：统一管理所有接入网关的代理模块。
 */

import type {
  GatewayModule,
  ModuleContext,
  ModuleModelInfo,
  ModuleStatus,
  RouteConfig,
} from './types.ts'
import { WorkBuddyModule } from '../modules/workbuddy/index.ts'
import { AntigravityModule } from '../modules/antigravity/index.ts'
import { PassthroughModule } from '../modules/passthrough/index.ts'

export class ModuleHost {
  private modules = new Map<string, GatewayModule>()
  private wbModule = new WorkBuddyModule()
  private agyModule = new AntigravityModule()
  private passModule = new PassthroughModule()

  constructor() {
    this.register(this.wbModule)
    this.register(this.agyModule)
    this.register(this.passModule)
  }

  register(module: GatewayModule): void {
    this.modules.set(module.id, module)
  }

  getModule(id: string): GatewayModule | undefined {
    return this.modules.get(id)
  }

  getWorkBuddyModule(): WorkBuddyModule {
    return this.wbModule
  }

  getAntigravityModule(): AntigravityModule {
    return this.agyModule
  }

  getPassthroughModule(): PassthroughModule {
    return this.passModule
  }

  getAllModules(): GatewayModule[] {
    return Array.from(this.modules.values())
  }

  async initAll(context: ModuleContext): Promise<void> {
    for (const mod of this.modules.values()) {
      try {
        await mod.init(context)
        context.log(`模块 [${mod.name}] 初始化成功`)
      } catch (err: any) {
        context.log(`模块 [${mod.name}] 初始化失败: ${err.message}`)
      }
    }
  }

  /** 获取所有模块提供的所有模型集合 */
  async aggregateModels(): Promise<Array<{ module: string; model: ModuleModelInfo }>> {
    const list: Array<{ module: string; model: ModuleModelInfo }> = []
    for (const [id, mod] of this.modules.entries()) {
      try {
        const models = await mod.listModels()
        for (const m of models) {
          list.push({ module: id, model: m })
        }
      } catch {}
    }
    return list
  }

  /** 收集所有模块的健康与余额状态 */
  async collectStatuses(): Promise<Record<string, ModuleStatus>> {
    const result: Record<string, ModuleStatus> = {}
    for (const [id, mod] of this.modules.entries()) {
      if (typeof mod.getStatus === 'function') {
        try {
          result[id] = await mod.getStatus()
        } catch (err: any) {
          result[id] = { online: false, details: { error: err.message } }
        }
      }
    }
    return result
  }

  async disposeAll(): Promise<void> {
    for (const mod of this.modules.values()) {
      if (typeof mod.dispose === 'function') {
        try {
          await mod.dispose()
        } catch {}
      }
    }
  }
}
