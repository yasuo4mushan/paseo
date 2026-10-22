/**
 * 会话目录 store（t20）：对话主页与右侧会话抽屉共用的单一数据源
 * （替代 t15-t19 的 pages/agents 页内 state，避免两套列表逻辑）。
 *
 * 职责：
 *  - 持有 agent 全量列表 + agent_update 增量维护（applyAgentUpdate）；
 *  - 活跃会话 id（豆包式直达：进入主页即上次活跃会话；按连接持久化）；
 *  - 全量刷新（refresh 注入 fetcher —— store 不 import connection-manager，
 *    保持 Node 可测：@tarojs/taro 顶层引用构建期常量，Node 下不可加载）。
 *
 * 接线（src/connection/connection-manager）：
 *  - onAgentUpdate → sessionStore.applyAgentUpdate（同 attentionStore 转发模式）；
 *  - onDisconnect → teardownSessionState → sessionStore.reset()。
 *
 * 平台纪律：单例挂 globalThis（原因见 permission-store.ts）；不用
 * useSyncExternalStore（Taro reconciler 下订阅不可靠，页面一律 useState+useEffect）。
 */

import type { AgentSnapshot } from "@/connection/protocol-types";
import { filterAgents, sortAgents, type AgentListFilter } from "@/utils/agent-directory";

type Listener = () => void;

export interface SessionDirectoryState {
  agents: AgentSnapshot[];
  activeId: string | null;
  /** 最近一次 refresh 的错误（页面错误条用；空 = 无错）。 */
  error: string;
}

class SessionStore {
  private state: SessionDirectoryState = { agents: [], activeId: null, error: "" };
  private listeners = new Set<Listener>();
  /** fetch 世代：refresh 在途时断线/换连接（reset 递增）后到达的结果作废。 */
  private generation = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionDirectoryState => this.state;

  private setState(patch: Partial<SessionDirectoryState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** 活跃会话快照（不存在/已归档时为 null）。 */
  activeAgent(): AgentSnapshot | null {
    const id = this.state.activeId;
    if (!id) return null;
    return this.state.agents.find((a) => a.id === id && !a.archivedAt) ?? null;
  }

  /** 会话目录（抽屉渲染：筛选 + 排序，纯函数复用 agent-directory）。 */
  directory(filter: AgentListFilter): AgentSnapshot[] {
    return sortAgents(filterAgents(this.state.agents, filter));
  }

  setActive(agentId: string | null): void {
    if (agentId === this.state.activeId) return;
    this.setState({ activeId: agentId });
    this.persistActive(agentId);
  }

  private persistActive(agentId: string | null): void {
    try {
      this.setStorageImpl(agentId);
    } catch {
      // storage 不可用时静默（内存态仍生效）
    }
  }

  /**
   * 全量刷新（连接建立后/下拉刷新调用；fetcher 由调用方注入——拿当前连接的
   * fetchAgents({includeArchived:true})）。同时：
   *  - 恢复持久化的活跃会话（仅当该会话仍存在于本连接且未归档）；
   *  - 活跃会话失效（被归档/删除）→ 回退最新未归档会话（豆包式直达）。
   */
  async refresh(fetchAgents: () => Promise<AgentSnapshot[]>): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    try {
      const agents = await fetchAgents();
      if (generation !== this.generation) return; // 在途时已断线/复位，丢弃
      let activeId = this.state.activeId;
      if (!activeId) {
        const stored = this.readStoredActive();
        if (stored && agents.some((a) => a.id === stored && !a.archivedAt)) activeId = stored;
      }
      if (!activeId || !agents.some((a) => a.id === activeId && !a.archivedAt)) {
        activeId = sortAgents(filterAgents(agents, "active"))[0]?.id ?? null;
      }
      this.setState({ agents, activeId, error: "" });
      if (activeId) this.persistActive(activeId);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * agent_update 增量维护（connection-manager 订阅转发；单测直接调用）：
   * upsert 合并去重；remove 时若移除的是活跃会话 → 回退最新未归档会话。
   */
  applyAgentUpdate(
    update: { kind: "upsert"; agent: AgentSnapshot } | { kind: "remove"; agentId: string },
  ): void {
    if (update.kind === "remove") {
      const agents = this.state.agents.filter((a) => a.id !== update.agentId);
      let activeId = this.state.activeId;
      if (activeId === update.agentId) {
        activeId = sortAgents(filterAgents(agents, "active"))[0]?.id ?? null;
        this.persistActive(activeId);
      }
      this.setState({ agents, activeId });
      return;
    }
    const agents = [...this.state.agents.filter((a) => a.id !== update.agent.id), update.agent];
    this.setState({ agents });
  }

  /** 断线/换连接时复位（连接已断，目录与活跃会话随连接失效）。 */
  reset(): void {
    this.generation += 1; // 作废在途 refresh
    this.setState({ agents: [], activeId: null, error: "" });
  }

  /** 注入测试替身（Node 下默认内存实现）。 */
  private memoryActive: string | null = null;
  private getStorage: () => string | null = () => this.memoryActive;
  private setStorageImpl: (v: string | null) => void = (v) => {
    this.memoryActive = v;
  };

  installStorage(get: () => string | null, set: (v: string | null) => void): void {
    this.getStorage = get;
    this.setStorageImpl = set;
  }

  private readStoredActive(): string | null {
    try {
      return this.getStorage();
    } catch {
      return null;
    }
  }
}

/** 单例经 globalThis 固定（HMR/多 bundle 下保持同一实例）。 */
const GLOBAL_KEY = "__aaswitch_session_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: SessionStore };
export const sessionStore: SessionStore = (globalScope[GLOBAL_KEY] ??= new SessionStore());
