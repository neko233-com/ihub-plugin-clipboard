/*
 * Minimal standalone client for iHub's public frontend bridge protocol.
 * This file is intentionally vendored with the plugin so a Git import never
 * needs the root iHub workspace or a Tauri API in the iframe.
 */

export type JsonPrimitive = string | number | boolean | null;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface CommandDefinition {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
}

export interface CommandInvocation {
  requestId: string;
  commandId: string;
  input?: Json;
  context?: Record<string, Json>;
}

export interface CommandResult {
  message?: string;
  data?: Json;
  close?: boolean;
}

export interface SearchProviderDefinition {
  id: string;
  title: string;
  trigger?: string;
  priority?: number;
}

export interface SearchRequest {
  requestId: string;
  providerId: string;
  query: string;
  limit?: number;
  context?: Record<string, Json>;
}

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  score?: number;
  payload?: Json;
}

interface HostRequest {
  pluginId: string;
  method: string;
  params?: Json;
}

type Unlisten = () => void | Promise<void>;
type BridgeListener<T> = (payload: T) => void | Promise<void>;
type CommandHandler = (request: CommandInvocation) => CommandResult | void | Promise<CommandResult | void>;
type SearchHandler = (request: SearchRequest) => SearchResult[] | Promise<SearchResult[]>;

interface HostBridge {
  call<T = unknown>(request: HostRequest): Promise<T>;
  listen<T = unknown>(name: string, listener: BridgeListener<T>): Promise<Unlisten>;
}

declare global {
  interface Window {
    __IHUB_PLUGIN_API__?: HostBridge;
  }
}

export interface PluginContext {
  readonly pluginId: string;
  readonly commands: {
    register(definition: CommandDefinition, handler: CommandHandler): Promise<Disposable>;
  };
  readonly search: {
    register(definition: SearchProviderDefinition, handler: SearchHandler): Promise<Disposable>;
  };
  readonly settings: {
    get<T extends Json>(key: string, fallback?: T): Promise<T>;
    set(key: string, value: Json): Promise<void>;
  };
  readonly clipboard: {
    readText(): Promise<string>;
    writeText(value: string): Promise<void>;
  };
  readonly events: {
    on<T = unknown>(name: string, listener: BridgeListener<T>): Promise<Disposable>;
  };
  readonly logger: {
    debug(message: string, details?: Json): void;
    info(message: string, details?: Json): void;
    warn(message: string, details?: Json): void;
    error(message: string, details?: Json): void;
  };
}

export interface DevelopmentBridge extends HostBridge {
  emit<T = unknown>(name: string, payload: T): Promise<void>;
}

interface BootstrapOptions {
  bridge?: HostBridge;
  onError?: (error: unknown) => void;
}

const REQUEST_CHANNEL = "ihub-plugin-bridge/v1";
const RESPONSE_CHANNEL = "ihub-host-bridge/v1";
const CALL_TIMEOUT_MS = 30_000;

function asJson(value: unknown): Json {
  return value as Json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventName(pluginId: string, kind: string): string {
  return `ihub://plugin/${pluginId}/${kind}`;
}

function createFrameBridge(): HostBridge {
  const hostWindow = window.parent;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: number }>();
  const listeners = new Map<string, Set<BridgeListener<unknown>>>();
  let sequence = 0;

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== hostWindow || !isRecord(event.data)) {
      return;
    }
    const message = event.data;
    if (message.channel !== RESPONSE_CHANNEL) {
      return;
    }
    if (message.type === "event" && typeof message.name === "string") {
      void Promise.all([...(listeners.get(message.name) ?? [])].map((listener) => listener(message.payload)));
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") {
      return;
    }
    const call = pending.get(message.id);
    if (!call) {
      return;
    }
    pending.delete(message.id);
    window.clearTimeout(call.timeout);
    if (message.ok === true) {
      call.resolve(message.result);
    } else {
      call.reject(new Error(typeof message.error === "string" ? message.error : "iHub host call failed."));
    }
  });

  return {
    call<T>(request: HostRequest): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = `clipboard-history-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
        const timeout = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error("iHub host call timed out."));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
        hostWindow.postMessage({ channel: REQUEST_CHANNEL, type: "call", id, request }, "*");
      });
    },
    async listen<T>(name: string, listener: BridgeListener<T>): Promise<Unlisten> {
      const callbacks = listeners.get(name) ?? new Set<BridgeListener<unknown>>();
      const wrapped = listener as BridgeListener<unknown>;
      callbacks.add(wrapped);
      listeners.set(name, callbacks);
      return () => {
        callbacks.delete(wrapped);
        if (callbacks.size === 0) {
          listeners.delete(name);
        }
      };
    },
  };
}

/** True only in an iHub iframe or an alternate injected bridge surface. */
export function hasIHubHost(): boolean {
  return typeof window !== "undefined" && Boolean(window.__IHUB_PLUGIN_API__ || window.parent !== window);
}

function hostBridge(): HostBridge {
  if (typeof window === "undefined") {
    throw new Error("iHub plugins need a browser WebView.");
  }
  return window.__IHUB_PLUGIN_API__ ?? createFrameBridge();
}

async function browserCopy(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const scratch = document.createElement("textarea");
  scratch.value = value;
  scratch.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(scratch);
  scratch.select();
  const copied = document.execCommand("copy");
  scratch.remove();
  if (!copied) {
    throw new Error("当前浏览器不允许写入剪贴板。");
  }
}

/**
 * Browser-only preview transport. It holds settings in memory and can use
 * browser Clipboard APIs only after the user presses a control; it never
 * polls or persists clipboard content outside the desktop host.
 */
export function createDevelopmentBridge(): DevelopmentBridge {
  const settings = new Map<string, Json>();
  const listeners = new Map<string, Set<BridgeListener<unknown>>>();
  return {
    async call<T>(request: HostRequest): Promise<T> {
      const params = (request.params ?? {}) as Record<string, Json>;
      switch (request.method) {
        case "settings.get":
          return (settings.get(String(params.key)) ?? params.fallback) as T;
        case "settings.set":
          settings.set(String(params.key), params.value);
          return undefined as T;
        case "clipboard.readText":
          if (!navigator.clipboard?.readText) {
            throw new Error("当前浏览器不提供 Clipboard Read API。");
          }
          return await navigator.clipboard.readText() as T;
        case "clipboard.writeText":
          await browserCopy(String(params.value ?? ""));
          return undefined as T;
        default:
          return undefined as T;
      }
    },
    async listen<T>(name: string, listener: BridgeListener<T>): Promise<Unlisten> {
      const callbacks = listeners.get(name) ?? new Set<BridgeListener<unknown>>();
      const wrapped = listener as BridgeListener<unknown>;
      callbacks.add(wrapped);
      listeners.set(name, callbacks);
      return () => {
        callbacks.delete(wrapped);
        if (callbacks.size === 0) {
          listeners.delete(name);
        }
      };
    },
    async emit<T>(name: string, payload: T): Promise<void> {
      await Promise.all([...(listeners.get(name) ?? [])].map((listener) => listener(payload)));
    },
  };
}

class Runtime implements Disposable {
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private readonly searchHandlers = new Map<string, SearchHandler>();
  private readonly unlisten: Unlisten[] = [];
  private commandsReady = false;
  private searchReady = false;
  private disposed = false;
  readonly context: PluginContext;

  constructor(
    private readonly pluginId: string,
    private readonly bridge: HostBridge,
    private readonly onError: (error: unknown) => void,
  ) {
    this.context = {
      pluginId,
      commands: { register: (definition, handler) => this.registerCommand(definition, handler) },
      search: { register: (definition, handler) => this.registerSearch(definition, handler) },
      settings: {
        get: <T extends Json>(key: string, fallback?: T) => this.getSetting(key, fallback),
        set: async (key, value) => { await this.call("settings.set", { key, value }); },
      },
      clipboard: {
        readText: () => this.call<string>("clipboard.readText"),
        writeText: (value) => this.call("clipboard.writeText", { value }),
      },
      events: { on: (name, listener) => this.listen(name, listener) },
      logger: {
        debug: (message, details) => this.log("debug", message, details),
        info: (message, details) => this.log("info", message, details),
        warn: (message, details) => this.log("warn", message, details),
        error: (message, details) => this.log("error", message, details),
      },
    };
  }

  async activate(activate: (context: PluginContext) => void | Promise<void>): Promise<void> {
    await activate(this.context);
    await this.call("lifecycle.ready");
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.commandHandlers.clear();
    this.searchHandlers.clear();
    await Promise.all(this.unlisten.splice(0).map((dispose) => Promise.resolve(dispose())));
    await this.bridge.call({ pluginId: this.pluginId, method: "lifecycle.dispose" }).catch(this.onError);
  }

  private async registerCommand(definition: CommandDefinition, handler: CommandHandler): Promise<Disposable> {
    this.assertActive();
    if (this.commandHandlers.has(definition.id)) {
      throw new Error(`Duplicate command: ${definition.id}`);
    }
    await this.ensureCommandListener();
    this.commandHandlers.set(definition.id, handler);
    await this.call("commands.register", { definition: asJson(definition) });
    return this.registration("commands.unregister", definition.id, this.commandHandlers, "commandId");
  }

  private async registerSearch(definition: SearchProviderDefinition, handler: SearchHandler): Promise<Disposable> {
    this.assertActive();
    if (this.searchHandlers.has(definition.id)) {
      throw new Error(`Duplicate search provider: ${definition.id}`);
    }
    await this.ensureSearchListener();
    this.searchHandlers.set(definition.id, handler);
    await this.call("search.register", { definition: asJson(definition) });
    return this.registration("search.unregister", definition.id, this.searchHandlers, "providerId");
  }

  private registration(method: string, id: string, handlers: Map<string, unknown>, key: string): Disposable {
    let used = false;
    return {
      dispose: async () => {
        if (used) {
          return;
        }
        used = true;
        handlers.delete(id);
        await this.call(method, { [key]: id });
      },
    };
  }

  private async ensureCommandListener(): Promise<void> {
    if (this.commandsReady) {
      return;
    }
    this.unlisten.push(await this.bridge.listen<CommandInvocation>(eventName(this.pluginId, "command"), (request) => this.handleCommand(request)));
    this.commandsReady = true;
  }

  private async ensureSearchListener(): Promise<void> {
    if (this.searchReady) {
      return;
    }
    this.unlisten.push(await this.bridge.listen<SearchRequest>(eventName(this.pluginId, "search"), (request) => this.handleSearch(request)));
    this.searchReady = true;
  }

  private async handleCommand(request: CommandInvocation): Promise<void> {
    const handler = this.commandHandlers.get(request.commandId);
    if (!handler) {
      await this.respond("commands.complete", request.requestId, false, null, `Unknown command: ${request.commandId}`);
      return;
    }
    try {
      await this.respond("commands.complete", request.requestId, true, (await handler(request)) ?? {});
    } catch (error) {
      this.onError(error);
      await this.respond("commands.complete", request.requestId, false, null, errorText(error));
    }
  }

  private async handleSearch(request: SearchRequest): Promise<void> {
    const handler = this.searchHandlers.get(request.providerId);
    if (!handler) {
      await this.respond("search.complete", request.requestId, false, [], `Unknown search provider: ${request.providerId}`);
      return;
    }
    try {
      await this.respond("search.complete", request.requestId, true, await handler(request));
    } catch (error) {
      this.onError(error);
      await this.respond("search.complete", request.requestId, false, [], errorText(error));
    }
  }

  private async respond(method: string, requestId: string, ok: boolean, result: unknown, error?: string): Promise<void> {
    await this.call(method, { requestId, ok, result: asJson(result), error: error ?? null });
  }

  private async getSetting<T extends Json>(key: string, fallback?: T): Promise<T> {
    const value = await this.call<T | undefined>("settings.get", { key, fallback: fallback ?? null });
    return (value === undefined ? fallback : value) as T;
  }

  private async listen<T>(name: string, listener: BridgeListener<T>): Promise<Disposable> {
    this.assertActive();
    const dispose = await this.bridge.listen<T>(eventName(this.pluginId, `event/${name}`), listener);
    this.unlisten.push(dispose);
    return { dispose };
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, details?: Json): void {
    void this.call("log", { level, message, details: details ?? null }).catch(this.onError);
  }

  private call<T = unknown>(method: string, params?: Json): Promise<T> {
    this.assertActive();
    return this.bridge.call<T>({ pluginId: this.pluginId, method, params });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error(`Plugin runtime for ${this.pluginId} has already been disposed.`);
    }
  }
}

export async function bootstrapPlugin(
  pluginId: string,
  activate: (context: PluginContext) => void | Promise<void>,
  options: BootstrapOptions = {},
): Promise<Disposable> {
  const onError = options.onError ?? ((error: unknown) => console.error(`[${pluginId}]`, error));
  const runtime = new Runtime(pluginId, options.bridge ?? hostBridge(), onError);
  try {
    await runtime.activate(activate);
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
