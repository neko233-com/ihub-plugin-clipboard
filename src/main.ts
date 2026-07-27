import {
  bootstrapPlugin,
  createDevelopmentBridge,
  hasIHubHost,
  type Disposable,
  type PluginContext,
  type SearchResult,
} from "./ihub-sdk";
import "./style.css";

const PLUGIN_ID = "ihub-plugin-clipboard";
const ITEMS_SETTING_KEY = "items";
const MAX_ITEMS = 36;
const MAX_ITEM_CHARACTERS = 1_500;
const MAX_SERIALIZED_BYTES = 60_000;
const isBrowserPreview = !hasIHubHost();
const previewBridge = isBrowserPreview ? createDevelopmentBridge() : undefined;

type StatusTone = "ready" | "success" | "error";

interface ClipboardEntry {
  id: string;
  text: string;
  capturedAt: string;
  pinned: boolean;
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("The Clipboard History plugin root is missing.");
}

app.innerHTML = `
  <section class="clipboard-history" aria-labelledby="clipboard-history-title">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">▣</span>
        <div>
          <p class="eyebrow">IHUB OFFICIAL PLUGIN</p>
          <h1 id="clipboard-history-title">剪贴板历史</h1>
        </div>
      </div>
      <p id="environment-note" class="environment-note"><span aria-hidden="true">◆</span></p>
    </header>

    <section class="intro" aria-label="隐私说明">
      <div>
        <p class="section-kicker">CONSENT-FIRST · TEXT ONLY</p>
        <h2>只在你点击“收集当前内容”时读取文本</h2>
      </div>
      <p>不后台轮询、不收集图片或文件、不上传内容。固定、删除与复制都需你再次确认操作。</p>
    </section>

    <section class="capture-bar" aria-label="收集剪贴板文本">
      <div class="capture-copy">
        <p class="section-kicker">CAPTURE</p>
        <strong>当前系统剪贴板</strong>
        <span>点击后才请求 <code>clipboard.read</code> 权限。</span>
      </div>
      <button id="capture-current" class="primary-action" type="button">收集当前内容</button>
    </section>

    <section class="library" aria-labelledby="library-title">
      <div class="library-heading">
        <div>
          <p class="section-kicker">LOCAL COLLECTION</p>
          <h2 id="library-title">已收集文本</h2>
        </div>
        <button id="clear-unpinned" class="quiet-danger" type="button">清除未固定</button>
      </div>
      <div class="filter-row">
        <label class="filter-field" for="history-filter">
          <span class="sr-only">筛选已收集文本</span>
          <input id="history-filter" autocomplete="off" placeholder="筛选本机文本" type="search" />
        </label>
        <label class="pinned-toggle" for="pinned-only">
          <input id="pinned-only" type="checkbox" />
          <span>仅固定</span>
        </label>
      </div>
      <p id="collection-summary" class="collection-summary" aria-live="polite"></p>
      <div id="history-list" class="history-list" aria-live="polite"></div>
    </section>

    <footer class="statusline" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      <p id="status"></p>
    </footer>
  </section>
`;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing Clipboard History element: #${id}`);
  }
  return element as T;
}

const environmentNote = requiredElement<HTMLElement>("environment-note");
const captureCurrentButton = requiredElement<HTMLButtonElement>("capture-current");
const clearUnpinnedButton = requiredElement<HTMLButtonElement>("clear-unpinned");
const filterInput = requiredElement<HTMLInputElement>("history-filter");
const pinnedOnlyInput = requiredElement<HTMLInputElement>("pinned-only");
const collectionSummary = requiredElement<HTMLElement>("collection-summary");
const historyList = requiredElement<HTMLElement>("history-list");
const status = requiredElement<HTMLElement>("status");

let context: PluginContext | null = null;
let runtime: Disposable | null = null;
let entries: ClipboardEntry[] = [];
let selectedEntryId: string | null = null;
let captureInFlight = false;

function setStatus(message: string, tone: StatusTone = "ready"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

function timestamp(): string {
  return new Date().toISOString();
}

function itemId(): string {
  const randomPart = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `clip-${randomPart}`;
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedFilter(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sortedEntries(values: ClipboardEntry[]): ClipboardEntry[] {
  return [...values].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  });
}

function normalizeEntries(raw: unknown): ClipboardEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const restored: ClipboardEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const rawText = typeof record.text === "string" ? record.text : "";
    const text = rawText.slice(0, MAX_ITEM_CHARACTERS);
    const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : timestamp();
    if (!id || !text.trim() || ids.has(id)) {
      continue;
    }
    ids.add(id);
    restored.push({ id, text, capturedAt, pinned: record.pinned === true });
    if (restored.length >= MAX_ITEMS) {
      break;
    }
  }
  return sortedEntries(restored);
}

function serializedEntries(): string {
  return JSON.stringify(entries);
}

async function persistEntries(): Promise<void> {
  if (!context) {
    throw new Error("插件尚未准备好。");
  }
  const serialized = serializedEntries();
  if (textBytes(serialized) > MAX_SERIALIZED_BYTES) {
    throw new Error("本机记录已接近宿主设置上限；请删除一些较长的文本后再保存。");
  }
  await context.settings.set(ITEMS_SETTING_KEY, serialized);
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "刚刚";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactText(value: string, limit = 88): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function visibleEntries(): ClipboardEntry[] {
  const query = normalizedFilter(filterInput.value);
  return entries.filter((entry) => {
    if (pinnedOnlyInput.checked && !entry.pinned) {
      return false;
    }
    return !query || entry.text.toLocaleLowerCase().includes(query);
  });
}

function actionButton(label: string, action: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "history-action";
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = title;
  button.textContent = label;
  return button;
}

function renderEntries(): void {
  const visible = visibleEntries();
  const pinnedCount = entries.filter((entry) => entry.pinned).length;
  collectionSummary.textContent = entries.length === 0
    ? "暂无记录。收集一段文本后，它只会保存到此插件的本机设置。"
    : `共 ${entries.length} 条 · 已固定 ${pinnedCount} 条 · 当前显示 ${visible.length} 条`;
  clearUnpinnedButton.disabled = !entries.some((entry) => !entry.pinned);
  historyList.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const title = document.createElement("strong");
    title.textContent = entries.length ? "没有匹配的本机文本" : "尚未开始收集";
    const copy = document.createElement("span");
    copy.textContent = entries.length
      ? "调整筛选条件，或关闭“仅固定”。"
      : "iHub 不会后台读取剪贴板；点击上方按钮后才会收集当前纯文本。";
    empty.append(title, copy);
    historyList.append(empty);
    return;
  }

  for (const entry of visible) {
    const row = document.createElement("article");
    row.className = "history-row";
    row.dataset.entryId = entry.id;
    if (entry.pinned) {
      row.classList.add("is-pinned");
    }
    if (entry.id === selectedEntryId) {
      row.classList.add("is-selected");
    }

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const state = document.createElement("span");
    state.className = entry.pinned ? "entry-state is-pinned" : "entry-state";
    state.textContent = entry.pinned ? "已固定" : "本机文本";
    const time = document.createElement("time");
    time.dateTime = entry.capturedAt;
    time.textContent = displayTime(entry.capturedAt);
    const size = document.createElement("span");
    size.className = "entry-size";
    size.textContent = `${textBytes(entry.text).toLocaleString()} B`;
    meta.append(state, time, size);

    const text = document.createElement("p");
    text.className = "entry-text";
    text.textContent = entry.text;
    text.title = entry.text;

    const actions = document.createElement("div");
    actions.className = "history-actions";
    actions.append(
      actionButton("复制", "copy", "复制到系统剪贴板"),
      actionButton(entry.pinned ? "取消固定" : "固定", "pin", entry.pinned ? "取消固定" : "固定到顶部"),
      actionButton("删除", "delete", "删除这条本机记录"),
    );
    row.append(meta, text, actions);
    historyList.append(row);
  }
}

async function updateEntries(next: ClipboardEntry[], successMessage: string): Promise<void> {
  const previous = entries;
  entries = sortedEntries(next);
  try {
    await persistEntries();
    renderEntries();
    setStatus(successMessage, "success");
  } catch (error) {
    entries = previous;
    renderEntries();
    setStatus(error instanceof Error ? error.message : "无法保存本机记录。", "error");
  }
}

async function captureCurrentClipboard(): Promise<void> {
  if (!context || captureInFlight) {
    return;
  }
  captureInFlight = true;
  captureCurrentButton.disabled = true;
  captureCurrentButton.textContent = "正在读取…";
  try {
    const clipboardText = await context.clipboard.readText();
    if (!clipboardText.trim()) {
      setStatus("当前剪贴板没有可收集的文本。", "error");
      return;
    }
    const wasTruncated = clipboardText.length > MAX_ITEM_CHARACTERS;
    const text = clipboardText.slice(0, MAX_ITEM_CHARACTERS);
    const duplicate = entries.find((entry) => entry.text === text);
    const now = timestamp();
    const next = duplicate
      ? [{ ...duplicate, capturedAt: now }, ...entries.filter((entry) => entry.id !== duplicate.id)]
      : [{ id: itemId(), text, capturedAt: now, pinned: false }, ...entries];
    await updateEntries(next.slice(0, MAX_ITEMS), wasTruncated
      ? `已收集前 ${MAX_ITEM_CHARACTERS.toLocaleString()} 个字符；长文本已截断。`
      : duplicate
        ? "相同文本已移到最近位置。"
        : "已收集当前文本，并保存到本机插件设置。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "无法读取系统剪贴板。", "error");
  } finally {
    captureInFlight = false;
    captureCurrentButton.disabled = false;
    captureCurrentButton.textContent = "收集当前内容";
  }
}

async function copyEntry(id: string): Promise<void> {
  const entry = entries.find((item) => item.id === id);
  if (!entry || !context) {
    return;
  }
  try {
    await context.clipboard.writeText(entry.text);
    selectedEntryId = id;
    renderEntries();
    setStatus("已复制到系统剪贴板。", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "无法写入系统剪贴板。", "error");
  }
}

async function togglePinned(id: string): Promise<void> {
  const entry = entries.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  await updateEntries(
    entries.map((item) => item.id === id ? { ...item, pinned: !item.pinned } : item),
    entry.pinned ? "已取消固定。" : "已固定到顶部。",
  );
}

async function deleteEntry(id: string): Promise<void> {
  if (!entries.some((entry) => entry.id === id)) {
    return;
  }
  if (selectedEntryId === id) {
    selectedEntryId = null;
  }
  await updateEntries(entries.filter((entry) => entry.id !== id), "已删除这条本机记录。");
}

async function clearUnpinnedEntries(): Promise<void> {
  if (!entries.some((entry) => !entry.pinned)) {
    return;
  }
  if (!window.confirm("清除所有未固定的本机剪贴板记录？固定条目会保留。")) {
    return;
  }
  selectedEntryId = null;
  await updateEntries(entries.filter((entry) => entry.pinned), "已清除未固定记录。");
}

function selectEntryFromSearch(id: string): void {
  const entry = entries.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  selectedEntryId = id;
  filterInput.value = "";
  pinnedOnlyInput.checked = false;
  renderEntries();
  historyList.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus("已定位到这条文本；请点击“复制”后再写入系统剪贴板。", "ready");
}

function searchResults(query: string, limit?: number): SearchResult[] {
  const normalized = normalizedFilter(query);
  return entries
    .filter((entry) => !normalized || entry.text.toLocaleLowerCase().includes(normalized))
    .slice(0, Math.min(limit ?? 8, 12))
    .map((entry, index) => ({
      id: `clipboard-entry-${entry.id}`,
      title: compactText(entry.text),
      subtitle: `${entry.pinned ? "已固定 · " : ""}${displayTime(entry.capturedAt)} · ${textBytes(entry.text).toLocaleString()} B`,
      score: (entry.pinned ? 1.2 : 1) - index / 100,
      payload: { entryId: entry.id },
    }));
}

historyList.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
  const row = target?.closest<HTMLElement>("[data-entry-id]");
  const id = row?.dataset.entryId;
  if (!target || !id) {
    return;
  }
  switch (target.dataset.action) {
    case "copy":
      void copyEntry(id);
      break;
    case "pin":
      void togglePinned(id);
      break;
    case "delete":
      void deleteEntry(id);
      break;
  }
});

captureCurrentButton.addEventListener("click", () => void captureCurrentClipboard());
clearUnpinnedButton.addEventListener("click", () => void clearUnpinnedEntries());
filterInput.addEventListener("input", renderEntries);
pinnedOnlyInput.addEventListener("change", renderEntries);

async function activate(pluginContext: PluginContext): Promise<void> {
  context = pluginContext;
  environmentNote.innerHTML = "";
  const environmentMark = document.createElement("span");
  environmentMark.setAttribute("aria-hidden", "true");
  environmentMark.textContent = "◆";
  environmentNote.append(environmentMark, document.createTextNode(
    isBrowserPreview ? "浏览器预览 · 临时内存" : "本机插件设置",
  ));

  const stored = await context.settings.get<string>(ITEMS_SETTING_KEY, "[]");
  try {
    entries = normalizeEntries(JSON.parse(stored));
  } catch {
    entries = [];
    setStatus("旧的本机记录无法读取，已以空列表启动。", "error");
  }

  await context.commands.register(
    {
      id: "open-clipboard-history",
      title: "Open clipboard history",
      subtitle: "Capture, pin, search, and reuse local clipboard text",
      keywords: ["clipboard", "clip", "paste", "history", "剪贴板", "历史"],
    },
    async () => {
      filterInput.focus();
      return { message: "Clipboard History is ready.", close: false };
    },
  );

  await context.search.register(
    {
      id: "clipboard-history",
      title: "Clipboard history",
      trigger: "clip ",
      priority: 35,
    },
    (request) => searchResults(request.query, request.limit),
  );

  await context.events.on<unknown>("search.select", (event) => {
    if (!event || typeof event !== "object") {
      return;
    }
    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      return;
    }
    const entryId = (payload as { entryId?: unknown }).entryId;
    if (typeof entryId === "string") {
      selectEntryFromSearch(entryId);
    }
  });
  context.logger.info("Clipboard History plugin activated", { browserPreview: isBrowserPreview });
}

void bootstrapPlugin(PLUGIN_ID, activate, {
  bridge: previewBridge,
  onError(error) {
    setStatus(error instanceof Error ? error.message : "插件桥接错误。", "error");
    console.error(error);
  },
}).then((value) => {
  runtime = value;
  renderEntries();
  setStatus(isBrowserPreview
    ? "浏览器预览不会后台读取剪贴板；点击收集按钮时会请求浏览器权限。"
    : "准备就绪。点击收集后才会读取当前纯文本剪贴板。",
  );
}).catch((error) => {
  setStatus(error instanceof Error ? error.message : "插件无法启动。", "error");
});

window.addEventListener("pagehide", () => {
  void runtime?.dispose();
  runtime = null;
  context = null;
});

renderEntries();
