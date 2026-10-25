import { LEGACY_PASEO_ENV_PREFIX, withLegacyPaseoEnvAliases } from "./env-compat.js";

// Daemon configuration inputs. General provider credentials and executable/runtime
// controls remain available to managed launches and their agent processes.
export const DAEMON_SETTING_ENV_KEYS = [
  "MCP_DEBUG",
  "OPENAI_STT_BASE_URL",
  "OPENAI_TTS_BASE_URL",
  "AASWITCH_ALLOWED_HOSTS",
  "AASWITCH_APP_BASE_URL",
  "AASWITCH_CORS_ORIGINS",
  "AASWITCH_DICTATION_ENABLED",
  "AASWITCH_DICTATION_LANGUAGE",
  "AASWITCH_DICTATION_LOCAL_STT_MODEL",
  "AASWITCH_DICTATION_STT_PROVIDER",
  "AASWITCH_GIT_CONCURRENCY",
  "AASWITCH_GIT_MAX_PROCESSES_PER_SECOND",
  "AASWITCH_GIT_MAX_PROCESS_CONCURRENCY",
  "AASWITCH_HOSTNAMES",
  "AASWITCH_HUB_TOKEN",
  "AASWITCH_HUB_URL",
  "AASWITCH_LISTEN",
  "AASWITCH_LOCAL_MODELS_DIR",
  "AASWITCH_LOG",
  "AASWITCH_LOG_CONSOLE_FORMAT",
  "AASWITCH_LOG_CONSOLE_LEVEL",
  "AASWITCH_LOG_FILE_LEVEL",
  "AASWITCH_LOG_FILE_PATH",
  "AASWITCH_LOG_FILE_ROTATE_COUNT",
  "AASWITCH_LOG_FILE_ROTATE_SIZE",
  "AASWITCH_LOG_FORMAT",
  "AASWITCH_LOG_LEVEL",
  "AASWITCH_LOG_ROTATE_COUNT",
  "AASWITCH_LOG_ROTATE_SIZE",
  "AASWITCH_PASSWORD",
  "AASWITCH_PLUGIN_REGISTRY",
  "AASWITCH_RELAY_ENABLED",
  "AASWITCH_RELAY_ENDPOINT",
  "AASWITCH_RELAY_PUBLIC_ENDPOINT",
  "AASWITCH_RELAY_PUBLIC_USE_TLS",
  "AASWITCH_RELAY_USE_TLS",
  "AASWITCH_SERVICE_PROXY_ENABLED",
  "AASWITCH_SERVICE_PROXY_LISTEN",
  "AASWITCH_SERVICE_PROXY_PUBLIC_BASE_URL",
  "AASWITCH_TRUSTED_PROXIES",
  "AASWITCH_VOICE_LANGUAGE",
  "AASWITCH_VOICE_LLM_PROVIDER",
  "AASWITCH_VOICE_LOCAL_STT_MODEL",
  "AASWITCH_VOICE_LOCAL_TTS_MODEL",
  "AASWITCH_VOICE_LOCAL_TTS_SPEAKER_ID",
  "AASWITCH_VOICE_LOCAL_TTS_SPEED",
  "AASWITCH_VOICE_MODE_ENABLED",
  "AASWITCH_VOICE_STT_PROVIDER",
  "AASWITCH_VOICE_TTS_PROVIDER",
  "AASWITCH_VOICE_TURN_DETECTION_PROVIDER",
  "AASWITCH_WEB_UI_DIST_DIR",
  "AASWITCH_WEB_UI_ENABLED",
  "PORT",
  "STT_CONFIDENCE_THRESHOLD",
  "STT_MODEL",
  "TTS_MODEL",
  "TTS_VOICE",
] as const;

const CONFIG_CONTEXT_ENV_KEYS = [
  "AASWITCH_NODE_ENV",
  "AASWITCH_DESKTOP_MANAGED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_STT_API_KEY",
  "OPENAI_TTS_API_KEY",
] as const;

function legacyEnvKey(key: string): string {
  return `${LEGACY_PASEO_ENV_PREFIX}${key.slice("AASWITCH_".length)}`;
}

// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
// PASEO_* predecessors of the AASWITCH_* setting keys. Kept so managed
// launches scrub both spellings and persisted config from before the rename
// still resolves.
export function legacyDaemonSettingEnvKeys(): string[] {
  return [...DAEMON_SETTING_ENV_KEYS, ...CONFIG_CONTEXT_ENV_KEYS]
    .filter((key) => key.startsWith("AASWITCH_"))
    .map(legacyEnvKey);
}

export function configurationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = withLegacyPaseoEnvAliases(env);
  return Object.fromEntries(
    [...DAEMON_SETTING_ENV_KEYS, ...CONFIG_CONTEXT_ENV_KEYS].map((key) => [key, merged[key]]),
  );
}

export function daemonLaunchEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...input.env };
  if (input.mode === "managed") {
    for (const key of DAEMON_SETTING_ENV_KEYS) delete env[key];
    // COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
    for (const key of legacyDaemonSettingEnvKeys()) delete env[key];
  }
  delete env.AASWITCH_HOST;
  delete env.PASEO_HOST;
  delete env.AASWITCH_DESKTOP_MANAGED;
  delete env.PASEO_DESKTOP_MANAGED;
  env.AASWITCH_HOME = input.home;
  // COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
  env.PASEO_HOME = input.home;
  if (input.desktopManaged) {
    env.AASWITCH_DESKTOP_MANAGED = "1";
    env.PASEO_DESKTOP_MANAGED = "1";
  }
  return env;
}
