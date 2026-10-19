---
title: Supported providers
description: Every coding agent Paseo can launch, natively supported providers and the ACP catalog.
nav: Supported providers
order: 21
category: Providers
---

# Supported providers

For the concept and how Paseo manages providers, see [Providers](/docs/providers). To add or configure your own, see [Custom providers](/docs/custom-providers).

## Native support

Work out of the box once the underlying CLI is installed and authenticated.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Anthropic's coding agent with MCP support, streaming, and deep reasoning.
- [Codex](/docs/codex). OpenAI's workspace agent with sandbox controls and optional network access.
- [OpenCode](https://opencode.ai/). Open-source coding assistant with multi-provider model support.
- [Pi](https://pi.dev). Minimal terminal-based coding agent with multi-provider LLM support.
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code). Moonshot AI's coding agent, via Agent Client Protocol.
- [CodeBuddy Code](https://www.codebuddy.cn/cli/). Tencent's coding agent, via Agent Client Protocol.
- [Qoder](https://qoder.com). Alibaba's Qoder CLI coding agent, via Agent Client Protocol.
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/overview). Alibaba's Qwen Code CLI coding agent, via Agent Client Protocol.
- [Antigravity](#antigravity). Uses your installed `agy` CLI through a built-in provider plugin.
- [Muse Code](/docs/muse-code). Meta's terminal coding agent, bundled as a provider plugin.

### Antigravity

Install the Antigravity CLI (`agy`) on your daemon host, then run `agy` once to sign in. Pick
**Antigravity** in Paseo. The provider ships with Paseo; no separate plugin install is required.

**Full access** is the only permission mode. Antigravity cannot ask for permission when another
app drives it, so Paseo starts `agy` with `--dangerously-skip-permissions`. Every tool call,
including shell commands, runs without asking. Each session starts with a warning explaining
this, including when you reopen a chat. Antigravity's own policy can still deny
an action.

After a daemon restart, Antigravity remembers the conversation, but Paseo's transcript starts
fresh because `agy` does not replay its history.

This integration uses your installed CLI and sign-in. It is not endorsed by Google.

Paseo MCP tools and steering are unavailable. Your own `agy` MCP servers still work. Attached
images are passed as file references for the agent to read.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Use `env`
for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

See [Custom providers](/docs/custom-providers) for command and environment overrides.

### Kimi Code CLI

Install the [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) on your daemon host
(`npm install -g @moonshot-ai/kimi-code` or your package manager's equivalent), then run
`kimi` once to sign in with your Moonshot account. Paseo launches `kimi acp` and discovers
models, modes, and per-model thinking options over the Agent Client Protocol.

If `kimi` is outside your daemon's PATH, override the command in
`~/.paseo/config.json`. Use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "kimi": {
        "command": ["/absolute/path/to/kimi", "acp"],
        "env": { "KIMI_LOG_LEVEL": "debug" }
      }
    }
  }
}
```

Configs from older releases that added Kimi from the ACP catalog (`extends: "acp"`)
keep working: the built-in provider takes over and honors the same command and env
settings.

### CodeBuddy Code

Install [CodeBuddy Code](https://www.codebuddy.cn/cli/) on your daemon host
(`npm install -g @tencent-ai/codebuddy-code` or Tencent's installer), then run
`codebuddy` once to sign in with your Tencent account (iOA, Google, GitHub, WeChat, or a
self-hosted enterprise domain). Paseo launches `codebuddy --acp` and discovers models and
modes over the Agent Client Protocol.

If `codebuddy` is outside your daemon's PATH, override the command in
`~/.paseo/config.json`. Use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "codebuddy-code": {
        "command": ["/absolute/path/to/codebuddy", "--acp"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

Configs from older releases that added CodeBuddy from the ACP catalog
(`extends: "acp"`) keep working: the built-in provider takes over and honors the same
command and env settings.

### Qoder

Install the [Qoder CLI](https://qoder.com) on your daemon host
(`npm install -g @qoder-ai/qodercli` or your package manager's equivalent), then run
`qoder login` once to sign in with your Qoder account. Paseo launches `qoder --acp` and
discovers models and modes over the Agent Client Protocol.

If `qoder` is outside your daemon's PATH, override the command in
`~/.paseo/config.json`. Use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "qoder": {
        "command": ["/absolute/path/to/qoder", "--acp"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

Configs from older releases that added Qoder from the ACP catalog
(`extends: "acp"`) keep working: the built-in provider takes over and honors the same
command and env settings.

### Qwen Code

Install the [Qwen Code CLI](https://qwenlm.github.io/qwen-code-docs/en/users/overview) on
your daemon host (`npm install -g @qwen-code/qwen-code` or your package manager's
equivalent), then authenticate once: run `qwen` and complete the Qwen account sign-in, or
set `OPENAI_API_KEY` for the OpenAI-compatible API-key mode the ACP handshake advertises.
Paseo launches `qwen --acp` and discovers models and modes over the Agent Client Protocol.

If `qwen` is outside your daemon's PATH, override the command in
`~/.paseo/config.json`. Use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "qwen-code": {
        "command": ["/absolute/path/to/qwen", "--acp"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

Configs from older releases that added Qwen Code from the ACP catalog
(`extends: "acp"`) keep working: the built-in provider takes over and honors the same
command and env settings.

## ACP catalog

Pick any of these from the in-app provider catalog. Each entry is a one-click install of the underlying CLI.

- [Agoragentic](https://agoragentic.com), agent marketplace with 174+ AI capabilities.
- [Amp](https://github.com/tao12345666333/amp-acp), frontier coding agent.
- [Auggie CLI](https://www.augmentcode.com/), Augment Code's agent backed by their context engine.
- [Autohand Code](https://www.autohand.ai/cli/), Autohand AI's coding agent.
- [Cline](https://cline.bot/cli), autonomous coding agent.
- [CodeWhale](https://codewhale.net/), terminal coding agent for DeepSeek V4 and open models.
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli), Snowflake's coding agent.
- [Corust Agent](https://github.com/Corust-ai/corust-agent-release/releases), Rust-focused coding partner.
- [crow-cli](https://crow-ai.dev/), minimal ACP-native coding agent.
- [Cursor](https://cursor.com/docs/cli/overview), Cursor's coding agent.
- [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview), LangChain-powered coding agent.
- [DimCode](https://dimcode.dev/docs/acp.html), multi-model coding agent.
- [Dirac](https://dirac.run), open-source agent with hash-anchored parallel edits.
- [Factory Droid](https://factory.ai/product/cli), Factory AI's coding agent.
- [fast-agent](https://fast-agent.ai/acp/), multi-provider coding agent.
- [Gajae Code](https://gajae-code.com), subscription-based coding agent with plan-before-mutation workflows.
- [Gemini CLI](https://geminicli.com), Google's official Gemini CLI.
- [GitHub Copilot](https://github.com/features/copilot/cli/), GitHub's AI pair programmer via ACP.
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent), Zhipu AI's GLM coding agent.
- [goose](https://block.github.io/goose/), Block's local open-source AI agent.
- [Grok](https://docs.x.ai/build/overview), xAI's Grok Build agentic coding CLI.
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), Nous Research's self-improving agent.
- [Hoplite](#hoplite), cloud coding agent through its local ACP bridge.
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html), JetBrains' coding agent.
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli), open-source coding agent.
- [Minion Code](https://github.com/femto/minion-code), Minion-framework coding agent.
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe), Mistral's open-source CLI assistant.
- [Nova](https://www.compassap.ai/portfolio/nova.html), Compass AI's software engineer.
- [Poolside](https://docs.poolside.ai/cli/pool), Poolside's coding agent.
- [siGit Code](https://github.com/getsigit/sigit), local-first coding agent with optional on-device LLM.
- [Stakpak](https://stakpak.dev/), Rust-based DevOps agent.
- [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli), ByteDance's official TRAE coding agent.
- [VT Code](https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md), open-source multi-provider coding agent.

The in-app catalog is the canonical, version-pinned source. Anything not listed here can still be added manually, see [Custom providers](/docs/custom-providers).

### Hoplite

Install the [Hoplite CLI](https://hoplite.sh/docs/cli) on your daemon host and run
`hoplite login`. In **Settings → Hosts → your host → Providers**, find **Hoplite**
in the catalog and choose **Add**. Paseo launches `hoplite acp` through the generic ACP adapter.

Hoplite runs the agent in a cloud workspace. Open a repository linked to a Hoplite project,
or set `agents.providers.hoplite.env.HOPLITE_PROJECT_ID` to use one project everywhere.
Without a linked repository or pinned project, discovery reports `No Hoplite project`.
Your local files and Paseo's loopback MCP tools are not available in that cloud workspace.

See [Hoplite's ACP guide](https://hoplite.sh/docs/cli/acp) for authentication and project setup.
Use a [command override](/docs/custom-providers) if `hoplite` is outside your daemon's PATH;
keep `acp` in the arguments.
