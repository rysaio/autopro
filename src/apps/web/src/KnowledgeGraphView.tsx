import {
  AlertTriangle,
  Bug,
  Camera,
  Globe,
  Search,
  Shield,
  UserX,
  X,
  ZoomIn,
  ZoomOut,
  Loader2,
  RotateCcw,
  Wrench,
  Activity,
  FileText,
  Layers,
  Cpu,
  Zap,
  Radio,
  BarChart3,
  Workflow,
  Terminal
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type {
  ToolManifest,
  AgentSessionSummary,
  AgentSessionDetail,
  EvidenceArtifact,
  ToolInvocation,
  ProviderStatus
} from "@secops-agent/shared";
import type { McpToolSummary } from "./api.js";

// ── Types ──
export type KgNodeType = "tool" | "session" | "artifact" | "threat";

export interface KgNode {
  id: string;
  label: string;
  type: KgNodeType;
  risk?: "low" | "medium" | "high" | "critical";
  description?: string;
  details?: Record<string, string>;
  source?: string;
}

export interface KgEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type?: "contains" | "uses" | "monitors" | "produces" | "related-to" | "same-group";
}

interface Vec2 {
  x: number;
  y: number;
}

// ── Props ──
export interface KnowledgeGraphProps {
  tools: ToolManifest[];
  mcpTools: McpToolSummary[];
  sessions: AgentSessionSummary[];
  activeSession: AgentSessionDetail | null;
  streamArtifacts: EvidenceArtifact[];
  streamToolInvocations: ToolInvocation[];
  health: ProviderStatus | null;
}

// ── Node type styling ──
const NODE_STYLE: Record<KgNodeType, { color: string; bg: string; size: number }> = {
  tool: { color: "#d97706", bg: "#fffbeb", size: 28 },
  session: { color: "#2563eb", bg: "#eff6ff", size: 26 },
  artifact: { color: "#059669", bg: "#ecfdf5", size: 24 },
  threat: { color: "#dc2626", bg: "#fef2f2", size: 34 },
};

const TYPE_LABEL: Record<KgNodeType, string> = {
  tool: "工具",
  session: "会话",
  artifact: "证据产物",
  threat: "威胁",
};

// ── Dynamic node/edge builder ──
function buildGraphData(props: KnowledgeGraphProps): { nodes: KgNode[]; edges: KgEdge[] } {
  const nodes: KgNode[] = [];
  const edges: KgEdge[] = [];
  const toolIds = new Set<string>();
  const sessionIds = new Set<string>();

  // 1. Threat node (project context)
  nodes.push({
    id: "threat-root",
    label: "SecOps 安全态势",
    type: "threat",
    risk: "high",
    description: `模型: ${props.health?.model ?? "N/A"} | 自动化: ${props.health?.actionLevel ?? "N/A"}`,
    source: "Provider Status",
    details: {
      "Provider": props.health?.provider ?? "N/A",
      "Model": props.health?.model ?? "N/A",
      "自动化级别": props.health?.actionLevel ?? "N/A",
      "沙箱路径": props.health?.sandboxRoot ?? "N/A",
    },
  });

  // 2. Tool nodes (top 10 by risk: critical/high first, then medium)
  const sortedTools = [...props.tools].sort((a, b) => {
    const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (riskOrder[a.risk] ?? 2) - (riskOrder[b.risk] ?? 2);
  });
  const topTools = sortedTools.slice(0, 10);
  for (const tool of topTools) {
    toolIds.add(tool.id);
    nodes.push({
      id: `tool-${tool.id}`,
      label: tool.name,
      type: "tool",
      risk: (tool.risk as "low" | "medium" | "high" | "critical") ?? "medium",
      description: tool.description,
      source: tool.tags.join(", ") || "Tool Registry",
      details: {
        "风险等级": tool.risk,
        "工具类别": tool.toolClass,
        "MCP兼容": tool.mcpCompatible ? "是" : "否",
        "标签": tool.tags.join(", ") || "无",
      },
    });
    edges.push({
      id: `threat2tool-${tool.id}`,
      source: "threat-root",
      target: `tool-${tool.id}`,
      label: "提供",
      type: "monitors",
    });
  }

  // 4. Session nodes (recent 5)
  const topSessions = props.sessions.slice(0, 5);
  for (const sess of topSessions) {
    sessionIds.add(sess.id);
    const shortId = sess.id.slice(0, 8);
    nodes.push({
      id: `session-${sess.id}`,
      label: `会话 ${shortId}...`,
      type: "session",
      description: `运行${sess.runCount}次 | 消息${sess.messageCount}条`,
      source: "Agent Session",
      details: {
        "会话ID": sess.id,
        "运行次数": String(sess.runCount),
        "消息数": String(sess.messageCount),
        "工具调用": String(sess.toolInvocationCount),
        "待审批": String(sess.pendingApprovalCount),
        "创建时间": new Date(sess.createdAt).toLocaleString(),
      },
    });
  }

  // 5. Artifact nodes (from activeSession or streamArtifacts, top 5)
  const artifacts = props.activeSession?.artifacts ?? props.streamArtifacts;
  const topArtifacts = artifacts.slice(0, 5);
  for (const art of topArtifacts) {
    nodes.push({
      id: `artifact-${art.id}`,
      label: art.title.length > 20 ? art.title.slice(0, 20) + "..." : art.title,
      type: "artifact",
      description: art.summary,
      source: `Kind: ${art.kind}`,
      details: {
        "类型": art.kind,
        "摘要": art.summary,
        "创建时间": new Date(art.createdAt).toLocaleString(),
      },
    });
  }

  // 5b. Build relationships

  // Session ↔ Artifact (if activeSession has runs)
  if (props.activeSession) {
    for (const art of topArtifacts) {
      edges.push({
        id: `session2artifact-${art.id}`,
        source: `session-${props.activeSession.id}`,
        target: `artifact-${art.id}`,
        label: "产生",
        type: "produces",
      });
    }
  }

  // Tool invocations → sessions (from streamToolInvocations)
  const invocations = props.activeSession?.toolInvocations ?? props.streamToolInvocations;
  const topInvocations = invocations.slice(0, 8);
  for (const inv of topInvocations) {
    if (toolIds.has(inv.toolName)) {
      if (props.activeSession) {
        edges.push({
          id: `sess2tool-${props.activeSession.id}-${inv.toolName}`,
          source: `session-${props.activeSession.id}`,
          target: `tool-${inv.toolName}`,
          label: "调用",
          type: "uses",
        });
      }
    }
  }

  return { nodes, edges };
}

// ── Force Layout ── 单次计算，稳定不闪烁，防止节点重叠
function computeLayout(nodes: KgNode[], edges: KgEdge[], width: number, height: number): Map<string, Vec2> {
  const pos = new Map<string, Vec2>();
  const vel = new Map<string, Vec2>();
  const cx = width / 2;
  const cy = height / 2;

  // 初始化位置：圆形分散，间距更大
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = Math.min(width, height) * 0.38;
    pos.set(n.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    vel.set(n.id, { x: 0, y: 0 });
  });

  const nodeIds = nodes.map((n) => n.id);
  // 为每个节点预计算"半径"用于碰撞检测
  const nodeRadii = new Map<string, number>();
  nodes.forEach((n) => {
    nodeRadii.set(n.id, (NODE_STYLE[n.type]?.size ?? 28) + 20); // 节点半径 + padding
  });

  const nodeCount = nodeIds.length;
  // 动态调整参数：节点越多，排斥力越大
  const repulsion = 20000 + nodeCount * 2000;
  const idealEdgeLen = 160;
  const attraction = 0.001;
  const damping = 0.55;
  const centerGravity = 0.003;
  const iterations = 600 + nodeCount * 20;

  for (let frame = 0; frame < iterations; frame++) {
    // 冷却因子：越往后速度越慢
    const cooling = 1 - (frame / iterations) * 0.6;

    // Repulsion between all pairs
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodeIds[i]!;
        const b = nodeIds[j]!;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = (nodeRadii.get(a) ?? 48) + (nodeRadii.get(b) ?? 48);
        // 距离小于最小间距时，排斥力急剧增大
        const effectiveDist = Math.max(dist, minDist * 0.3);
        const force = repulsion / (effectiveDist * effectiveDist);
        const fx = (dx / dist) * force * cooling;
        const fy = (dy / dist) * force * cooling;
        vel.get(a)!.x -= fx; vel.get(a)!.y -= fy;
        vel.get(b)!.x += fx; vel.get(b)!.y += fy;
      }
    }

    // Attraction along edges — 弹簧力拉到理想边长
    for (const edge of edges) {
      const pa = pos.get(edge.source);
      const pb = pos.get(edge.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - idealEdgeLen;
      const fx = dx * attraction * displacement * cooling;
      const fy = dy * attraction * displacement * cooling;
      vel.get(edge.source)!.x += fx; vel.get(edge.source)!.y += fy;
      vel.get(edge.target)!.x -= fx; vel.get(edge.target)!.y -= fy;
    }

    // Center gravity + damping + apply
    for (const id of nodeIds) {
      const p = pos.get(id)!;
      const v = vel.get(id)!;
      v.x += (cx - p.x) * centerGravity;
      v.y += (cy - p.y) * centerGravity;
      v.x *= damping;
      v.y *= damping;
      p.x += v.x;
      p.y += v.y;
      p.x = Math.max(55, Math.min(width - 55, p.x));
      p.y = Math.max(55, Math.min(height - 55, p.y));
    }
  }

  // 碰撞后处理：显式分离重叠节点
  for (let pass = 0; pass < 5; pass++) {
    let moved = false;
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodeIds[i]!;
        const b = nodeIds[j]!;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = (nodeRadii.get(a) ?? 48) + (nodeRadii.get(b) ?? 48);
        if (dist < minDist) {
          const overlap = (minDist - dist) / 2 + 5;
          const fx = (dx / dist) * overlap;
          const fy = (dy / dist) * overlap;
          pa.x -= fx; pa.y -= fy;
          pb.x += fx; pb.y += fy;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  return pos;
}

// ── Icon Components ──
function NodeIcon({ type, size }: { type: KgNodeType; size: number }) {
  const s = size * 0.6;
  switch (type) {
    case "tool": return <Wrench size={s} />;
    case "session": return <Activity size={s} />;
    case "artifact": return <FileText size={s} />;
    case "threat": return <AlertTriangle size={s} />;
    default: return <Globe size={s} />;
  }
}

// ── Main Component ──
export function KnowledgeGraphView(props: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [selectedNode, setSelectedNode] = useState<KgNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<KgNodeType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<Vec2>({ x: 0, y: 0 });
  const didFitRef = useRef(false);
  const [graphReady, setGraphReady] = useState(false);

  // Build dynamic graph data from props
  const { allNodes, allEdges } = useMemo(() => {
    const result = buildGraphData(props);
    return { allNodes: result.nodes, allEdges: result.edges };
  }, [props.tools, props.sessions, props.activeSession, props.streamArtifacts, props.streamToolInvocations, props.health]);

  // Filter nodes
  const filteredNodes = useMemo(() => {
    return allNodes.filter((n) => {
      if (filterType !== "all" && n.type !== filterType) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return n.label.toLowerCase().includes(q) || (n.description || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [allNodes, filterType, searchQuery]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => {
    return allEdges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));
  }, [allEdges, filteredNodeIds]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timeoutId: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => {
            setDimensions({ width: w, height: h });
          }, 100);
        }
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timeoutId);
    };
  }, []);

  // Compute layout once, stable
  const nodePositions = useMemo(() => {
    const w = dimensions.width || 800;
    const h = dimensions.height || 500;
    return computeLayout(filteredNodes, filteredEdges, w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes, filteredEdges, dimensions.width, dimensions.height]);

  // 首次打开时自动适配视图：计算所有节点包围盒，缩放/平移使全部可见。
  // 适配完成前不渲染图（显示 loading 占位），避免用户看到未适配的初始状态
  // 或「从小放大」的闪变。
  useEffect(() => {
    if (!dimensions.width || !dimensions.height) {
      return;
    }
    if (nodePositions.size === 0) {
      // 空图谱直接就绪
      setGraphReady(true);
      return;
    }
    if (didFitRef.current) {
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pos of nodePositions.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    }
    const boxWidth = Math.max(1, maxX - minX);
    const boxHeight = Math.max(1, maxY - minY);
    const padding = 70;
    const availWidth = Math.max(1, dimensions.width - padding * 2);
    const availHeight = Math.max(1, dimensions.height - padding * 2);
    const targetZoom = Math.max(0.2, Math.min(3, Math.min(availWidth / boxWidth, availHeight / boxHeight)));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    setZoom(targetZoom);
    setPan({
      x: dimensions.width / 2 - centerX * targetZoom,
      y: dimensions.height / 2 - centerY * targetZoom
    });
    didFitRef.current = true;
    setGraphReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions.width, dimensions.height, nodePositions]);

  // Stats
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    allNodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    return counts;
  }, [allNodes]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as SVGElement;
    if (target.closest("[data-node-id]")) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.2, Math.min(3, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  return (
    <div className="kg-container">
      {/* Top bar */}
      <div className="kg-topbar">
        <div className="kg-stats">
          <div className="kg-stat">
            <span className="kg-stat-value">{allNodes.length}</span>
            <span className="kg-stat-label">节点</span>
          </div>
          <div className="kg-stat">
            <span className="kg-stat-value">{allEdges.length}</span>
            <span className="kg-stat-label">关系</span>
          </div>
        </div>

        <div className="kg-search-wrapper">
          <Search size={14} className="kg-search-icon" />
          <input className="kg-search" placeholder="搜索节点..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>

        <div className="kg-filter-tags">
          <button className={`kg-filter-tag ${filterType === "all" ? "active" : ""}`} onClick={() => setFilterType("all")}>全部</button>
          {Object.entries(TYPE_LABEL).filter(([k]) => typeCounts[k]).map(([key, label]) => (
            <button key={key} className={`kg-filter-tag ${filterType === key ? "active" : ""}`}
              onClick={() => setFilterType(key as KgNodeType)}
              style={filterType === key ? { borderColor: NODE_STYLE[key as KgNodeType].color, color: NODE_STYLE[key as KgNodeType].color } : {}}>
              {label} ({typeCounts[key]})
            </button>
          ))}
        </div>

        <div className="kg-zoom-controls">
          <button onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))}><ZoomOut size={14} /></button>
          <span className="kg-zoom-value">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(3, z + 0.2))}><ZoomIn size={14} /></button>
          <button onClick={resetView}><RotateCcw size={14} /></button>
        </div>
      </div>

      {/* Main graph area */}
      <div className="kg-main">
        <div ref={containerRef} className="kg-graph"
          onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel}>
          {graphReady ? (
          <svg width="100%" height="100%" style={{ cursor: isDragging ? "grabbing" : "grab", display: "block" }}>
            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              {/* Edges */}
              {filteredEdges.map((edge) => {
                const sp = nodePositions.get(edge.source);
                const tp = nodePositions.get(edge.target);
                if (!sp || !tp) return null;
                const isHighlighted = hoveredNode === edge.source || hoveredNode === edge.target;
                const mx = (sp.x + tp.x) / 2;
                const my = (sp.y + tp.y) / 2;
                const angle = (Math.atan2(tp.y - sp.y, tp.x - sp.x) * 180) / Math.PI;
                return (
                  <g key={edge.id}>
                    <line x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                      stroke={isHighlighted ? "#0f766e" : "#cbd5e1"}
                      strokeWidth={isHighlighted ? 2.5 : 1.5} strokeOpacity={isHighlighted ? 1 : 0.5} />
                    {isHighlighted && (
                      <>
                        <polygon points="-5,-4 6,0 -5,4" fill="#0f766e" transform={`translate(${mx},${my}) rotate(${angle})`} />
                        <text x={mx} y={my - 10} textAnchor="middle" fontSize="11" fill="#0f766e" fontWeight="700">{edge.label}</text>
                      </>
                    )}
                  </g>
                );
              })}

              {/* Nodes */}
              {filteredNodes.map((node) => {
                const pos = nodePositions.get(node.id);
                if (!pos) return null;
                const style = NODE_STYLE[node.type];
                const isSelected = selectedNode?.id === node.id;
                const isHovered = hoveredNode === node.id;
                const r = style.size;
                return (
                  <g key={node.id} data-node-id={node.id} transform={`translate(${pos.x},${pos.y})`}
                    onMouseEnter={() => setHoveredNode(node.id)} onMouseLeave={() => setHoveredNode(null)}
                    onClick={() => setSelectedNode(selectedNode?.id === node.id ? null : node)}
                    style={{ cursor: "pointer" }}>
                    {isSelected && (
                      <circle r={r + 8} fill="none" stroke={style.color} strokeWidth={2} opacity={0.3} />
                    )}
                    <circle r={r} fill={style.color} stroke="white" strokeWidth={2.5}
                      opacity={isHovered || isSelected ? 1 : 0.92} />
                    <foreignObject x={-r * 0.5} y={-r * 0.5} width={r} height={r}>
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "white" }}>
                        <NodeIcon type={node.type} size={r * 1.2} />
                      </div>
                    </foreignObject>
                    <text y={r + 15} textAnchor="middle" fontSize={isSelected ? 12 : 11}
                      fontWeight={isSelected ? 700 : 500} fill={isSelected ? "#0f172a" : "#475569"}
                      style={{ pointerEvents: "none", userSelect: "none" }}>
                      {node.label.length > 16 ? node.label.slice(0, 16) + "..." : node.label}
                    </text>
                    {node.risk && node.risk !== "low" && (
                      <circle r={4} cx={r - 2} cy={-(r - 2)}
                        fill={node.risk === "critical" ? "#dc2626" : node.risk === "high" ? "#ea580c" : "#d97706"}
                        stroke="white" strokeWidth={1.5} />
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          ) : (
            <div className="kg-loading">
              <Loader2 className="spin" size={20} aria-hidden="true" />
              <span>正在渲染图谱…</span>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="kg-detail">
            <div className="kg-detail-header">
              <h3 className="kg-detail-title">{selectedNode.label}</h3>
              <button className="kg-detail-close" onClick={() => setSelectedNode(null)}><X size={16} /></button>
            </div>
            <div className="kg-detail-meta">
              <span className="kg-detail-type" style={{ color: NODE_STYLE[selectedNode.type].color, background: NODE_STYLE[selectedNode.type].bg }}>
                {TYPE_LABEL[selectedNode.type]}
              </span>
              {selectedNode.risk && (
                <span className={`kg-risk-badge risk-${selectedNode.risk}`}>
                  {selectedNode.risk === "critical" ? "严重" : selectedNode.risk === "high" ? "高" : selectedNode.risk === "medium" ? "中" : "低"}
                </span>
              )}
              {selectedNode.source && <span className="kg-detail-source">{selectedNode.source}</span>}
            </div>
            {selectedNode.description && <p className="kg-detail-desc">{selectedNode.description}</p>}
            {selectedNode.details && (
              <div className="kg-detail-props">
                {Object.entries(selectedNode.details).map(([key, value]) => (
                  <div key={key} className="kg-detail-prop">
                    <span className="kg-detail-prop-key">{key}</span>
                    <span className="kg-detail-prop-value">{value}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="kg-detail-related">
              <h4>关联节点</h4>
              <div className="kg-related-list">
                {allEdges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id).map((e) => {
                  const relatedId = e.source === selectedNode.id ? e.target : e.source;
                  const relatedNode = allNodes.find((n) => n.id === relatedId);
                  if (!relatedNode) return null;
                  const isSource = e.source === selectedNode.id;
                  const style = NODE_STYLE[relatedNode.type];
                  return (
                    <button key={e.id} className="kg-related-item" onClick={() => setSelectedNode(relatedNode)}>
                      <span className="kg-related-badge" style={{ background: style.color }} />
                      <span className="kg-related-label">{relatedNode.label}</span>
                      <span className="kg-related-edge-label">
                        {isSource ? "→" : "←"} {e.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="kg-legend">
        {Object.entries(NODE_STYLE).filter(([k]) => typeCounts[k]).map(([key, style]) => (
          <div key={key} className="kg-legend-item">
            <span className="kg-legend-dot" style={{ background: style.color }} />
            <span>{TYPE_LABEL[key as KgNodeType]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
