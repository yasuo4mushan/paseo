/**
 * Git 改动页（t19）：commit 列表 → 单 commit 文件 → 逐行 +/- 着色 diff。
 *
 * RPC：checkout.commits.list.request + checkout.commits.file_diff.request
 * （vendor 自 messages.ts；diff 是 daemon 解析后的 ParsedDiffFile，无需客户端
 * 再解析 unified diff 文本）。对照 app 的 commit-file-diff-query / diff panel。
 */

import { useCallback, useEffect, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, ScrollView, View, Image } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { CheckoutCommit, ParsedDiffFile } from "@/connection/protocol-types";
import { useThemeClass } from "@/hooks/use-theme";
import { iconUrl } from "@/utils/icons";
import { workspaceStore } from "@/stores/workspace-store";
import { formatClock } from "@/utils/time";
import "./index.css";

const FILE_STATUS_LABEL: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function ChangesPage() {
  const themeClass = useThemeClass();
  const [commits, setCommits] = useState<CheckoutCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasWorkspace, setHasWorkspace] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  // diff 视图状态（overlay）
  const [diffFile, setDiffFile] = useState<ParsedDiffFile | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffTitle, setDiffTitle] = useState("");

  const load = useCallback(async () => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    const workspace = workspaceStore.getSnapshot();
    if (!workspace) {
      setHasWorkspace(false);
      return;
    }
    setHasWorkspace(true);
    setLoading(true);
    setError("");
    try {
      const result = await conn.listCommits(workspace.directory);
      setCommits(result.commits);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    workspaceStore.restore();
    void load();
  }, [load]);

  usePullDownRefresh(async () => {
    await load();
    Taro.stopPullDownRefresh();
  });

  const openDiff = async (commit: CheckoutCommit, path: string) => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    const workspace = workspaceStore.getSnapshot();
    if (!workspace) return;
    setDiffLoading(true);
    setDiffTitle(`${commit.shortSha} · ${fileName(path)}`);
    setDiffFile(null);
    try {
      const file = await conn.getCommitFileDiff({
        cwd: workspace.directory,
        sha: commit.sha,
        path,
      });
      setDiffFile(file);
      if (!file) {
        Taro.showToast({ title: "该文件无可展示的文本 diff（如二进制）", icon: "none" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  };

  const toggleCommit = (sha: string) => {
    setExpanded((prev) => (prev === sha ? null : sha));
  };

  return (
    <View className={`page changes-page ${themeClass}`}>
      {error ? <View className="error-inline">{error}</View> : null}
      {!hasWorkspace ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("diff")} />
          <View className="empty-title">未选择工作区</View>
          <View className="empty-desc">改动浏览基于当前工作区的 git 仓库。</View>
        </View>
      ) : loading && commits.length === 0 ? (
        <View className="card empty">
          <View className="empty-title">读取 commit…</View>
        </View>
      ) : commits.length === 0 && !error ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("spark")} />
          <View className="empty-title">没有 commit</View>
          <View className="empty-desc">该工作区（或基准分支）上暂无可展示的提交。</View>
        </View>
      ) : (
        <ScrollView className="changes-list" scrollY enhanced showScrollbar={false}>
          {commits.map((commit) => (
            <View key={commit.sha} className="card commit-card">
              <View className="commit-head" onClick={() => toggleCommit(commit.sha)}>
                <View className="commit-sha num">{commit.shortSha}</View>
                <View className="commit-main">
                  <View className="commit-subject">{commit.subject}</View>
                  <View className="faint commit-meta">
                    {commit.authorName} · {formatClock(commit.authorDate)} ·{" "}
                    {commit.isOnRemote ? "已推送" : "本地"}
                  </View>
                </View>
                <Image className="icon icon-sm commit-chevron" src={iconUrl("chevron-down")} style={{ transform: expanded === commit.sha ? "rotate(0deg)" : "rotate(-90deg)" }} />
              </View>
              {expanded === commit.sha ? (
                <View className="commit-files">
                  {commit.files.length === 0 ? (
                    <View className="faint commit-nofiles">该 commit 无文件改动记录</View>
                  ) : (
                    commit.files.map((file) => (
                      <View
                        key={file.path}
                        className="commit-file-row"
                        onClick={() => void openDiff(commit, file.path)}
                      >
                        <View className="commit-file-main">
                          <View className="commit-file-name num">{fileName(file.path)}</View>
                          <View className="faint commit-file-path num">{file.path}</View>
                        </View>
                        <View className="commit-file-nums">
                          {file.status ? (
                            <View className="commit-status">{FILE_STATUS_LABEL[file.status]}</View>
                          ) : null}
                          <View className="commit-add num">+{file.additions}</View>
                          <View className="commit-del num">-{file.deletions}</View>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}

      {diffLoading || diffFile ? (
        <View className="diff-overlay">
          <View className="preview-head">
            <View className="preview-title diff-title">{diffTitle}</View>
            <View
              className="preview-close"
              onClick={() => (setDiffFile(null), setDiffLoading(false))}
            >
              <Image className="icon" src={iconUrl("close")} />
            </View>
          </View>
          {diffLoading ? (
            <View className="card empty diff-loading">
              <View className="empty-title">解析 diff…</View>
            </View>
          ) : diffFile ? (
            <ScrollView className="diff-body" scrollY enhanced showScrollbar={false}>
              <View className="diff-summary">
                <View className="commit-add num">+{diffFile.additions}</View>
                <View className="commit-del num">-{diffFile.deletions}</View>
                <View className="faint num">{diffFile.path}</View>
              </View>
              {diffFile.status && diffFile.status !== "ok" ? (
                <View className="diff-note">
                  {diffFile.status === "too_large"
                    ? "diff 过大，仅展示部分"
                    : "二进制文件，无可展示内容"}
                </View>
              ) : null}
              {diffFile.hunks.map((hunk, hi) => (
                <View key={hi} className="diff-hunk">
                  <View className="diff-hunk-head num">
                    @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                  </View>
                  <ScrollView className="diff-lines-scroll" scrollX enhanced showScrollbar={false}>
                    <View className="diff-lines">
                      {hunk.lines.map((line, li) => (
                        <View key={li} className={`diff-line diff-line-${line.type} num`}>
                          <View className="diff-marker">
                            {line.type === "add" ? "+" : line.type === "remove" ? "-" : ""}
                          </View>
                          <View className="diff-content">{line.content || " "}</View>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <View className="diff-foot">
            <Button className="btn btn-mini diff-close-btn" onClick={() => setDiffFile(null)}>
              关闭
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}
