import React, { useMemo, useRef, useState } from "react";
import {
  Upload,
  Search,
  Trash2,
  Menu,
  RefreshCw,
  FileJson,
  Clock3,
  X,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
} from "lucide-react";

function safeArray(value) { return Array.isArray(value) ? value : []; }
function valuesOfRecord(value) { return !value || typeof value !== "object" || Array.isArray(value) ? [] : Object.values(value); }
function flattenDeep(input) {
  const out = [];
  const queue = Array.isArray(input) ? [...input] : [input];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) queue.unshift(...current);
    else if (current != null) out.push(current);
  }
  return out;
}
function parseMaybeNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function normalizeTimestamp(ts) { const n = parseMaybeNumber(ts); if (!n) return null; return n > 1e12 ? n : n * 1000; }
function formatDate(ts) {
  if (!ts) return "未知时间";
  try { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ts)); }
  catch { return "未知时间"; }
}
function formatDateTime(ts) {
  if (!ts) return "未知时间";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ts));
  } catch { return "未知时间"; }
}
function formatRange(start, end) {
  if (!start && !end) return "未知时间";
  if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`;
  return formatDate(start || end);
}
function estimateTokens(text) { if (!text) return 0; return Math.max(1, Math.round(String(text).length / 3.2)); }
function extractTextContent(value) {
  if (typeof value === "string") return value;
  if (typeof value?.text === "string") return value.text;
  if (Array.isArray(value?.parts)) return value.parts.map(extractTextContent).join("\n");
  if (Array.isArray(value)) return value.map(extractTextContent).join("\n");
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
function normalizeMessageWhitespace(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
function stripReasoningBlock(text) {
  const raw = String(text || "");
  return raw.replace(/<details\b[^>]*type=["']reasoning["'][^>]*>[\s\S]*?<\/details>\s*/gi, "").trim();
}
function parseReasoningBlock(text) {
  const raw = String(text || "");
  const match = raw.match(/<details\b[^>]*type=["']reasoning["'][^>]*>[\s\S]*?<\/details>/i);
  if (!match) return { reasoning: "", reasoningSummary: "Thought", cleaned: normalizeMessageWhitespace(raw) };
  const reasoningRaw = match[0];
  const summaryMatch = reasoningRaw.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : "Thought";
  const cleanedReasoning = normalizeMessageWhitespace(
    reasoningRaw.replace(/<details\b[^>]*>/i, "").replace(/<\/details>/i, "").replace(/<summary>[\s\S]*?<\/summary>/i, "")
  );
  return { reasoning: cleanedReasoning, reasoningSummary: summary, cleaned: normalizeMessageWhitespace(stripReasoningBlock(raw)) };
}
function normalizeRole(value) {
  const raw = String(value || "").toLowerCase();
  if (["user", "human"].includes(raw)) return "user";
  if (["assistant", "model", "bot", "ai"].includes(raw)) return "assistant";
  if (raw === "system") return "system";
  return raw || "unknown";
}
function collectMessages(rawChat) {
  const candidateSources = flattenDeep([
    rawChat?.messages, rawChat?.chat?.messages, rawChat?.chat?.history?.messages, rawChat?.history?.messages,
    rawChat?.messageMap, rawChat?.chat?.messageMap, rawChat?.nodes, rawChat?.chat?.nodes, rawChat?.mapping,
    rawChat?.chat?.mapping, valuesOfRecord(rawChat?.messages), valuesOfRecord(rawChat?.chat?.messages),
    valuesOfRecord(rawChat?.chat?.history?.messages), valuesOfRecord(rawChat?.history?.messages),
    valuesOfRecord(rawChat?.messageMap), valuesOfRecord(rawChat?.chat?.messageMap),
    valuesOfRecord(rawChat?.nodes), valuesOfRecord(rawChat?.chat?.nodes), valuesOfRecord(rawChat?.mapping),
    valuesOfRecord(rawChat?.chat?.mapping),
  ]);
  const rawMessages = candidateSources.filter((msg) => msg && typeof msg === "object");
  const map = new Map();
  rawMessages.forEach((msg, index) => {
    const maybeMessage = msg?.message && typeof msg.message === "object" ? { ...msg, ...msg.message } : msg;
    const id = String(maybeMessage.id || maybeMessage.messageId || maybeMessage.nodeId || maybeMessage.uuid || `auto-${index}`);
    const role = normalizeRole(maybeMessage.role || maybeMessage.author?.role || maybeMessage.sender || (maybeMessage.is_user_model ? "assistant" : ""));
    const content = extractTextContent(maybeMessage.content ?? maybeMessage.text ?? maybeMessage.message ?? maybeMessage.parts);
    const parsedContent = parseReasoningBlock(content);
    const normalized = {
      ...maybeMessage,
      id,
      parentId: maybeMessage.parentId ?? maybeMessage.parent ?? maybeMessage.parent_id ?? null,
      childrenIds: safeArray(maybeMessage.childrenIds ?? maybeMessage.children ?? maybeMessage.childIds ?? maybeMessage.child_ids),
      role,
      content: parsedContent.cleaned,
      reasoning: parsedContent.reasoning,
      reasoningSummary: parsedContent.reasoningSummary,
      hasReasoning: Boolean(parsedContent.reasoning),
      timestamp: normalizeTimestamp(maybeMessage.timestamp ?? maybeMessage.created_at ?? maybeMessage.createdAt ?? maybeMessage.updated_at ?? maybeMessage.time),
      modelName: maybeMessage.modelName || maybeMessage.model || maybeMessage.meta?.model || maybeMessage.metadata?.model || "",
    };
    if (!map.has(id)) map.set(id, normalized);
  });
  const messages = [...map.values()].filter((m) => m.role !== "system" && String(m.content || "").trim() !== "");
  if (!messages.length) return [];
  const linkedEnough = messages.some((m) => m.parentId) || messages.some((m) => safeArray(m.childrenIds).length > 0);
  if (!linkedEnough) return messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const byId = new Map(messages.map((m) => [String(m.id), m]));
  const ordered = [];
  const seen = new Set();
  function getChildren(node) {
    const viaChildrenIds = safeArray(node.childrenIds).map((id) => byId.get(String(id))).filter(Boolean);
    const viaParentId = messages.filter((m) => m.parentId != null && String(m.parentId) === String(node.id));
    return [...viaChildrenIds, ...viaParentId]
      .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
  function walk(node) {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    getChildren(node).forEach(walk);
  }
  const roots = messages.filter((m) => !m.parentId || !byId.has(String(m.parentId))).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  roots.forEach(walk);
  messages.filter((m) => !seen.has(m.id)).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).forEach(walk);
  return ordered.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}
function normalizeConversation(raw, index) {
  const source = raw?.chat && typeof raw.chat === "object" ? raw.chat : raw;
  const messages = collectMessages(raw);
  const title = source?.title || raw?.title || `未命名对话 ${index + 1}`;
  const createdAt = normalizeTimestamp(raw?.created_at || source?.created_at || source?.timestamp);
  const updatedAt = normalizeTimestamp(raw?.updated_at || source?.updated_at);
  const timestamps = messages.map((m) => m.timestamp).filter(Boolean);
  const start = timestamps.length ? Math.min(...timestamps) : createdAt;
  const end = timestamps.length ? Math.max(...timestamps) : updatedAt || createdAt;
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const tokens = messages.reduce((sum, m) => sum + (parseMaybeNumber(m?.usage?.total_tokens) || 0), 0) || estimateTokens(messages.map((m) => m.content || "").join("\n"));
  return { id: String(raw?.id || source?.id || `conversation-${index}`), title, messages, start, end, userCount, assistantCount, messageCount: messages.length, tokens };
}
function parseImportPayload(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const conversations = list.filter((item) => item && typeof item === "object").map((item, index) => normalizeConversation(item, index)).filter((c) => c.messageCount > 0 || c.title);
  if (!conversations.length) throw new Error("没有识别到可用的对话数据");
  return conversations.sort((a, b) => (b.end || 0) - (a.end || 0));
}
function groupMessagesByDay(messages) {
  const groups = new Map();
  messages.forEach((msg) => {
    const key = formatDate(msg.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  });
  return [...groups.entries()];
}
function dayKeyFromTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatMonthTitle(date) { return `${date.getFullYear()}年${date.getMonth() + 1}月`; }
function buildCalendarCells(viewDate, statsMap) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push({ empty: true, key: `empty-start-${i}` });
  const values = [];
  for (let day = 1; day <= totalDays; day += 1) {
    const current = new Date(year, month, day);
    const key = dayKeyFromTs(current.getTime());
    const stat = statsMap.get(key) || { messageCount: 0, conversationCount: 0, tokens: 0 };
    values.push(stat.messageCount + stat.tokens / 5000);
    cells.push({ empty: false, key, day, ...stat });
  }
  const maxValue = Math.max(...values, 0);
  const minPositive = Math.min(...values.filter((v) => v > 0), Infinity);
  const result = cells.map((cell) => {
    if (cell.empty) return cell;
    const value = cell.messageCount + cell.tokens / 5000;
    let intensity = 0;
    if (value > 0 && maxValue > 0) intensity = minPositive === Infinity ? 1 : Math.max(0.18, value / maxValue);
    return { ...cell, intensity };
  });
  while (result.length % 7 !== 0) result.push({ empty: true, key: `empty-end-${result.length}` });
  return result;
}
function formatCompactTokens(tokens) {
  if (!tokens) return "0";
  if (tokens >= 10000) return `${(tokens / 10000).toFixed(1)}w`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}
function calendarCellStyle(intensity, active) {
  const base = "calendar-day";
  if (!intensity) return active ? `${base} active empty-level` : `${base} empty-level`;
  if (intensity > 0.72) return active ? `${base} level-3 active` : `${base} level-3`;
  if (intensity > 0.45) return active ? `${base} level-2 active` : `${base} level-2`;
  return active ? `${base} level-1 active` : `${base} level-1`;
}
function Avatar({ value, alt, bg = "avatar-bg", size = "avatar-size" }) {
  const isImage = typeof value === "string" && (value.startsWith("data:") || value.startsWith("http"));
  return <div className={`avatar ${bg} ${size}`}>{isImage ? <img src={value} alt={alt} className="avatar-image" /> : <span>{value}</span>}</div>;
}
function renderInlineMarkdown(text) {
  const source = String(text || "");
  const lines = source.split("\n");
  return lines.map((line, lineIndex) => {
    const parts = [];
    const regex = /(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
    let lastIndex = 0;
    let match = null;
    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
      const token = match[0];
      if (token.startsWith("**") && token.endsWith("**")) {
        parts.push(<strong key={`b-${lineIndex}-${match.index}`} className="markdown-strong">{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("*") && token.endsWith("*")) {
        parts.push(<em key={`i-${lineIndex}-${match.index}`} className="markdown-em">{token.slice(1, -1)}</em>);
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < line.length) parts.push(line.slice(lastIndex));
    return <React.Fragment key={`line-${lineIndex}`}>{parts.length ? parts : line}{lineIndex < lines.length - 1 ? <br /> : null}</React.Fragment>;
  });
}
function MessageBubble({ message, userAvatar, assistantAvatar }) {
  const isUser = message.role === "user";
  const sideName = isUser ? "小猫" : "Daddy";
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <div className={`message-row ${isUser ? "message-row-user" : "message-row-ai"}`}>
      {!isUser && <Avatar value={assistantAvatar} alt="assistant avatar" bg="avatar-ai-bg" size="avatar-size" />}
      <div className={`message-column ${isUser ? "message-column-user" : "message-column-ai"}`}>
        {message.hasReasoning && !isUser ? (
          <div className="reasoning-card">
            <button onClick={() => setShowReasoning((v) => !v)} className="reasoning-toggle">
              <span>{message.reasoningSummary || "Thought"}</span>
              <span>{showReasoning ? "收起" : "展开"}</span>
            </button>
            {showReasoning ? <div className="reasoning-body">{renderInlineMarkdown(message.reasoning)}</div> : null}
          </div>
        ) : null}
        <div className={`message-bubble ${isUser ? "message-bubble-user" : "message-bubble-ai"}`}>{renderInlineMarkdown(message.content || "[空消息]")}</div>
        <div className={`message-meta ${isUser ? "message-meta-user" : "message-meta-ai"}`}>
          <span>{sideName}</span><span>·</span><span>{formatDateTime(message.timestamp)}</span>
          {message.modelName ? <><span>·</span><span className="message-model-tag">{message.modelName}</span></> : null}
        </div>
      </div>
      {isUser && <Avatar value={userAvatar} alt="user avatar" bg="avatar-user-bg" size="avatar-size" />}
    </div>
  );
}

export default function App() {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [avatarPanelOpen, setAvatarPanelOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const [messageQuery, setMessageQuery] = useState("");
  const [viewMode, setViewMode] = useState("current");
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDayKey, setSelectedDayKey] = useState("");
  const [selectedDayConversationTitle, setSelectedDayConversationTitle] = useState("");
  const [error, setError] = useState("");
  const [userAvatar, setUserAvatar] = useState("🧸");
  const [assistantAvatar, setAssistantAvatar] = useState("🤖");
  const inputRef = useRef(null);
  const userAvatarInputRef = useRef(null);
  const assistantAvatarInputRef = useRef(null);

  const selectedConversation = useMemo(() => conversations.find((c) => c.id === selectedId) || conversations[0] || null, [conversations, selectedId]);
  const filteredConversations = useMemo(() => {
    const q = conversationQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, conversationQuery]);
  const allMessages = useMemo(() => conversations.flatMap((c) => c.messages.map((m) => ({ ...m, conversationTitle: c.title, conversationId: c.id }))), [conversations]);
  const visibleMessages = useMemo(() => {
    const base = safeArray(selectedConversation?.messages);
    const q = messageQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) => String(m.content || "").toLowerCase().includes(q));
  }, [selectedConversation, messageQuery]);
  const groupedMessages = useMemo(() => groupMessagesByDay(visibleMessages), [visibleMessages]);
  const dayStatsMap = useMemo(() => {
    const map = new Map();
    conversations.forEach((conv) => {
      const seenConversationDays = new Set();
      conv.messages.forEach((msg) => {
        const key = dayKeyFromTs(msg.timestamp);
        if (!key) return;
        if (!map.has(key)) map.set(key, { dayKey: key, messageCount: 0, conversationCount: 0, tokens: 0 });
        const entry = map.get(key);
        entry.messageCount += 1;
        entry.tokens += estimateTokens(msg.content || "");
        if (!seenConversationDays.has(key)) {
          entry.conversationCount += 1;
          seenConversationDays.add(key);
        }
      });
    });
    return map;
  }, [conversations]);
  const calendarCells = useMemo(() => buildCalendarCells(calendarMonth, dayStatsMap), [calendarMonth, dayStatsMap]);
  const selectedDayMessages = useMemo(() => {
    if (!selectedDayKey) return [];
    return allMessages.filter((m) => dayKeyFromTs(m.timestamp) === selectedDayKey);
  }, [allMessages, selectedDayKey]);
  const selectedDayGrouped = useMemo(() => {
    const grouped = new Map();
    selectedDayMessages.forEach((msg) => {
      const title = msg.conversationTitle || "未命名对话";
      if (!grouped.has(title)) grouped.set(title, { title, messages: [], userCount: 0, assistantCount: 0 });
      const entry = grouped.get(title);
      entry.messages.push(msg);
      if (msg.role === "user") entry.userCount += 1;
      if (msg.role === "assistant") entry.assistantCount += 1;
    });
    return [...grouped.values()];
  }, [selectedDayMessages]);

  function isMobileScreen() { return typeof window !== "undefined" && window.innerWidth < 768; }
  function toggleSidebar() { if (isMobileScreen()) setSidebarOpen((v) => !v); else setDesktopSidebarCollapsed((v) => !v); }
  function closeSidebarOnMobile() { if (isMobileScreen()) setSidebarOpen(false); }
  async function handleFile(file) {
    if (!file) return;
    try {
      setError("");
      const text = await file.text();
      const parsed = parseImportPayload(text);
      setConversations(parsed);
      setSelectedId(parsed[0]?.id || null);
      closeSidebarOnMobile();
    } catch (e) { setError(e?.message || "导入失败，请确认 JSON 格式正确"); }
  }
  function handleAvatarUpload(file, target) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      if (target === "user") setUserAvatar(result);
      if (target === "assistant") setAssistantAvatar(result);
    };
    reader.readAsDataURL(file);
  }
  function shiftCalendarMonth(delta) { setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1)); }
  const showExpandedSidebar = isMobileScreen() ? sidebarOpen : !desktopSidebarCollapsed;

  return (
    <div className="app-shell">
      <div className="layout">
        {sidebarOpen ? <button onClick={() => setSidebarOpen(false)} className="mobile-overlay" /> : null}
        <aside className={`sidebar ${isMobileScreen() ? (sidebarOpen ? "sidebar-mobile-open" : "sidebar-mobile-closed") : (desktopSidebarCollapsed ? "sidebar-collapsed" : "sidebar-expanded")}`}>
          <div className="sidebar-card">
            <div className="sidebar-header">
              <div className="sidebar-header-top">
                {showExpandedSidebar ? <div><div className="sidebar-title">Daddy&小猫 Logs</div><div className="sidebar-subtitle">{conversations.length} 个对话 · {allMessages.length} 条消息</div></div> : <div />}
                <button onClick={toggleSidebar} className="icon-button">{isMobileScreen() && sidebarOpen ? <X size={20} /> : <Menu size={20} />}</button>
              </div>
            </div>
            {showExpandedSidebar ? (
              <div className="sidebar-body">
                <div className="search-card"><Search size={16} className="muted-icon" /><input value={conversationQuery} onChange={(e) => setConversationQuery(e.target.value)} placeholder="搜索对话标题..." className="plain-input" /></div>
                <div className="upload-card">
                  <div className="upload-label"><FileJson size={16} className="muted-icon" /> 导入导出的 JSON 备份</div>
                  <button onClick={() => inputRef.current?.click()} className="primary-button"><Upload size={16} /> 选择 JSON 文件</button>
                  <input ref={inputRef} type="file" accept="application/json,.json" className="hidden-input" onChange={(e) => handleFile(e.target.files?.[0])} />
                  {error ? <div className="error-text">{error}</div> : null}
                </div>
                <div className="collapse-card">
                  <button onClick={() => setAvatarPanelOpen((v) => !v)} className="collapse-toggle">
                    <div className="collapse-title"><ImageIcon size={16} className="muted-icon" /> 头像设置</div>
                    <span className="collapse-hint">{avatarPanelOpen ? "收起" : "展开"}</span>
                  </button>
                  {avatarPanelOpen ? (
                    <div className="avatar-panel">
                      <div>
                        <div className="avatar-section-title">用户头像</div>
                        <div className="avatar-row">
                          <Avatar value={userAvatar} alt="user avatar preview" bg="avatar-user-bg" size="avatar-large" />
                          <button onClick={() => userAvatarInputRef.current?.click()} className="pill-button">更换用户头像</button>
                          <input ref={userAvatarInputRef} type="file" accept="image/*" className="hidden-input" onChange={(e) => handleAvatarUpload(e.target.files?.[0], "user")} />
                        </div>
                      </div>
                      <div>
                        <div className="avatar-section-title">模型头像</div>
                        <div className="avatar-row">
                          <Avatar value={assistantAvatar} alt="assistant avatar preview" bg="avatar-ai-bg" size="avatar-large" />
                          <button onClick={() => assistantAvatarInputRef.current?.click()} className="pill-button">更换模型头像</button>
                          <input ref={assistantAvatarInputRef} type="file" accept="image/*" className="hidden-input" onChange={(e) => handleAvatarUpload(e.target.files?.[0], "assistant")} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="conversation-list">
                  {filteredConversations.map((conv) => (
                    <button key={conv.id} onClick={() => { setSelectedId(conv.id); setViewMode("current"); closeSidebarOnMobile(); }} className={`conversation-card ${selectedConversation?.id === conv.id ? "conversation-card-active" : ""}`}>
                      <div className="conversation-title">{conv.title}</div>
                      <div className="conversation-time">{formatRange(conv.start, conv.end)}</div>
                      <div className="conversation-stats">{conv.messageCount} 条消息 · {(conv.tokens / 1000).toFixed(1)}k tokens</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="sidebar-mini">
                <button onClick={() => setDesktopSidebarCollapsed(false)} className="mini-button"><Search size={20} /></button>
                <button onClick={() => inputRef.current?.click()} className="mini-button"><Upload size={20} /></button>
                <button onClick={() => setDesktopSidebarCollapsed(false)} className="mini-button"><ImageIcon size={20} /></button>
                <input ref={inputRef} type="file" accept="application/json,.json" className="hidden-input" onChange={(e) => handleFile(e.target.files?.[0])} />
              </div>
            )}
          </div>
        </aside>

        <main className="main">
          <div className="main-card">
            <div className="main-toolbar">
              <div className="toolbar-left">
                <button onClick={toggleSidebar} className="icon-button"><Menu size={20} /></button>
                <div className="toolbar-title-wrap">
                  <div className="toolbar-title">{selectedConversation?.title || "导入 JSON 后开始查看"}</div>
                  <div className="toolbar-subtitle">
                    <span>{selectedConversation ? formatRange(selectedConversation.start, selectedConversation.end) : "等待导入"}</span>
                    {selectedConversation ? <span>{selectedConversation.messageCount} 条消息</span> : null}
                    {selectedConversation ? <span>{(selectedConversation.tokens / 1000).toFixed(1)}k tokens</span> : null}
                  </div>
                </div>
                <button className="icon-button"><RefreshCw size={18} /></button>
              </div>

              <div className="toolbar-right">
                <div className="segmented-control">
                  <button onClick={() => setViewMode("current")} className={viewMode === "current" ? "segmented-active" : ""}>对话</button>
                  <button onClick={() => setViewMode("calendar")} className={viewMode === "calendar" ? "segmented-active" : ""}>统计</button>
                </div>
                <div className="search-inline"><Search size={16} className="muted-icon" /><input value={messageQuery} onChange={(e) => setMessageQuery(e.target.value)} placeholder="搜索消息内容..." className="plain-input" /></div>
              </div>
            </div>

            {!conversations.length ? (
              <div className="empty-state">
                <div className="empty-icon"><Upload size={28} /></div>
                <h2>把导出的 JSON 拖进来，或者点按钮导入</h2>
                <p>这个页面会自动解析对话、重建消息顺序、按日期分组，并用接近聊天记录的方式展示出来。</p>
                <button onClick={() => inputRef.current?.click()} className="primary-button">选择 JSON 文件</button>
              </div>
            ) : viewMode === "calendar" ? (
              <div className="calendar-view">
                <div className="calendar-shell">
                  <div className="calendar-header">
                    <div><div className="calendar-title">Daddy&小猫</div><div className="calendar-subtitle">{formatMonthTitle(calendarMonth)}</div></div>
                    <div className="calendar-nav">
                      <button onClick={() => shiftCalendarMonth(-1)} className="circle-pink-button"><ChevronLeft size={20} /></button>
                      <button onClick={() => shiftCalendarMonth(1)} className="circle-pink-button"><ChevronRight size={20} /></button>
                    </div>
                  </div>
                  <div className="calendar-body">
                    <div className="calendar-weekdays">{["日","一","二","三","四","五","六"].map((d) => <div key={d}>{d}</div>)}</div>
                    <div className="calendar-grid">
                      {calendarCells.map((cell) => cell.empty ? (
                        <div key={cell.key} className="calendar-empty" />
                      ) : (
                        <button key={cell.key} onClick={() => { setSelectedDayKey(cell.key); setSelectedDayConversationTitle(""); }} className={calendarCellStyle(cell.intensity, selectedDayKey === cell.key)}>
                          <div className="calendar-cell-top">
                            <div className="calendar-day-number">{cell.day}</div>
                            <div className="calendar-window-pill">{cell.conversationCount}窗</div>
                          </div>
                          <div className="calendar-cell-bottom">
                            <div className="calendar-message-count">{cell.messageCount} 条</div>
                            <div className="calendar-token-count">{formatCompactTokens(cell.tokens)}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {selectedDayKey ? (
                  <div className="day-detail-card">
                    <div className="day-detail-header">
                      <div className="day-detail-title"><CalendarDays size={18} className="muted-icon-pink" /> {selectedDayKey} 的对话内容</div>
                      <div className="day-detail-pill">{selectedDayMessages.length} 条消息</div>
                    </div>
                    {!selectedDayConversationTitle ? (
                      <div className="day-conversation-list">
                        {selectedDayGrouped.map((group) => (
                          <button key={group.title} onClick={() => setSelectedDayConversationTitle(group.title)} className="day-conversation-card">
                            <div>
                              <div className="day-conversation-title">{group.title}</div>
                              <div className="day-conversation-meta">{group.messages.length} 条消息 · 用户 {group.userCount} 条 · AI {group.assistantCount} 条</div>
                            </div>
                            <div className="day-conversation-arrow">›</div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div>
                        <button onClick={() => setSelectedDayConversationTitle("")} className="back-button">← 返回当天窗口列表</button>
                        {selectedDayGrouped.filter((group) => group.title === selectedDayConversationTitle).map((group) => (
                          <section key={group.title} className="selected-conversation-section">
                            <div className="selected-conversation-title">{group.title}</div>
                            <div className="message-list">
                              {group.messages.map((msg) => <MessageBubble key={msg.id} message={msg} userAvatar={userAvatar} assistantAvatar={assistantAvatar} />)}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="chat-view">
                <div className="message-day-list">
                  {groupedMessages.map(([day, items]) => (
                    <section key={day}>
                      <div className="day-label-wrap"><div className="day-label">{day}</div></div>
                      <div className="message-list">
                        {items.map((msg) => <div key={msg.id}><MessageBubble message={msg} userAvatar={userAvatar} assistantAvatar={assistantAvatar} /></div>)}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
