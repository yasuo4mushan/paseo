import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  hubLogin,
  hubRegisterAccount,
  HubApiError,
  type HubAccountManager,
} from "../../hub-account.js";

export interface HubAccountSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface HubAccountSessionOptions {
  host: HubAccountSessionHost;
  hubAccount: HubAccountManager;
  logger: pino.Logger;
}

export type HubAccountRequestMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "hub.status.request"
      | "hub.login.request"
      | "hub.register.request"
      | "hub.logout.request";
  }
>;

/**
 * Client-facing surface of the aaswitch Hub account integration: login,
 * register, status, and logout for the daemon's device registration. Owns the
 * `hub.*` account RPCs (not the Paseo Hub `hub.management.*` RPCs, which live
 * in DaemonSession).
 */
export class HubAccountSession {
  private readonly host: HubAccountSessionHost;
  private readonly hubAccount: HubAccountManager;
  private readonly logger: pino.Logger;

  constructor(options: HubAccountSessionOptions) {
    this.host = options.host;
    this.hubAccount = options.hubAccount;
    this.logger = options.logger;
  }

  /**
   * Requests may omit `baseUrl` (the zero-config path): the daemon then uses
   * its own resolved hub address — env override, persisted config, or the
   * built-in default. An explicit `baseUrl` always wins, which is how a
   * first-time login against a non-default hub bootstraps the persisted value.
   */
  private resolveBaseUrl(requestBaseUrl: string | undefined): string {
    const fromRequest = requestBaseUrl?.trim();
    if (fromRequest) return fromRequest;
    const fromConfig = this.hubAccount.status().baseUrl;
    if (fromConfig) return fromConfig;
    throw new HubApiError("Hub base URL is not configured", "hub.url_invalid");
  }

  async handleRequest(msg: HubAccountRequestMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "hub.status.request":
          this.host.emit({
            type: "hub.status.response",
            payload: { requestId: msg.requestId, status: this.hubAccount.status() },
          });
          return;
        case "hub.login.request": {
          const baseUrl = this.resolveBaseUrl(msg.baseUrl);
          const result = await hubLogin({
            baseUrl,
            username: msg.username,
            password: msg.password,
          });
          await this.hubAccount.applyCredentials({
            baseUrl,
            token: result.token,
            username: result.account.username,
          });
          this.host.emit({
            type: "hub.login.response",
            payload: {
              requestId: msg.requestId,
              accountId: result.account.id,
              username: result.account.username,
            },
          });
          return;
        }
        case "hub.register.request": {
          const baseUrl = this.resolveBaseUrl(msg.baseUrl);
          const result = await hubRegisterAccount({
            baseUrl,
            username: msg.username,
            password: msg.password,
          });
          const login = await hubLogin({ baseUrl, username: msg.username, password: msg.password });
          await this.hubAccount.applyCredentials({
            baseUrl,
            token: login.token,
            username: result.account.username,
            deviceName: msg.deviceName,
          });
          this.host.emit({
            type: "hub.register.response",
            payload: {
              requestId: msg.requestId,
              accountId: result.account.id,
              username: result.account.username,
            },
          });
          return;
        }
        case "hub.logout.request":
          await this.hubAccount.logout();
          this.host.emit({
            type: "hub.logout.response",
            payload: { requestId: msg.requestId },
          });
          return;
      }
    } catch (error) {
      const apiError = error instanceof HubApiError ? error : null;
      this.logger.error(
        { err: error, requestType: msg.type },
        "Failed to handle hub account request",
      );
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: apiError ? apiError.code : "handler_error",
        },
      });
    }
  }
}
