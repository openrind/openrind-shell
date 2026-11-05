/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Coins,
  ExternalLink,
  Folder,
  Image as ImageIcon,
  Layers,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "../../../design-system/button";

const settingsPanelClass =
  "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type CollectorStats = {
  project: string;
  spans: number;
  errors: number;
  total_sessions?: number;
  total_cost_usd?: number;
  favorite_model?: string | null;
  hands_off_median_s?: number;
  hands_off_p90_s?: number;
  intervention_density?: number;
  compactions_count?: number;
  warnings?: {
    total: number;
    admitted_mistakes: number;
    repeated_tool_failures: number;
  };
  by_observation_kind?: Record<string, number>;
  by_model?: Record<
    string,
    {
      count: number;
      cost_usd?: number;
      input_tokens?: number;
      output_tokens?: number;
      latency_ms?: { p50: number; p95: number; p99: number; n: number };
    }
  >;
};

export type TraceSpan = {
  trace_id: string;
  span_id: string;
  name: string;
  kind?: string;
  start_time: string;
  end_time: string;
  status: { code: string; message?: string };
  attributes?: Record<string, any>;
};

export type ArtifactModalData = {
  url: string;
  title: string;
  meta?: Record<string, any>;
};

export type HaloopAnalyticsViewProps = {
  collectorUrl?: string;
  status?: any;
  onRefreshRuntime?: () => Promise<void>;
};

function formatSeconds(sec?: number): string {
  if (!sec || isNaN(sec) || sec <= 0) return "0s";
  if (sec >= 60) {
    const mins = Math.floor(sec / 60);
    const remainder = Math.round(sec % 60);
    return remainder > 0 ? `${mins}m ${remainder}s` : `${mins}m`;
  }
  return `${sec.toFixed(1)}s`;
}

function formatCost(usd?: number): string {
  if (usd === undefined || usd === null || isNaN(usd)) return "$0.00";
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function HaloopAnalyticsView(props: HaloopAnalyticsViewProps) {
  const collectorUrl = (props.collectorUrl || "http://136.112.93.84:8788").replace(/\/+$/, "");
  const [stats, setStats] = useState<CollectorStats | null>(null);
  const [traces, setTraces] = useState<TraceSpan[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>(() => {
    if (typeof window !== "undefined") {
      try {
        return window.localStorage.getItem("openrind_haloop_selected_project") || "cld";
      } catch {
        return "cld";
      }
    }
    return "cld";
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactModalData | null>(null);

  // Custom searchable project dropdown state
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const activeRequestRef = useRef(0);

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!projectDropdownOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectDropdownOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [projectDropdownOpen]);

  const fetchCollector = useCallback(
    async (path: string) => {
      const bridge = (window as any).__OPENRIND_DESKTOP_ELECTRON__;
      if (bridge?.invokeDesktop) {
        try {
          return await bridge.invokeDesktop("openrindFetchCollector", path);
        } catch (err) {
          console.warn("[HaloopAnalyticsView] invokeDesktop fallback to direct fetch:", err);
        }
      }
      const fullUrl = `${collectorUrl}${path.startsWith("/") ? "" : "/"}${path}`;
      const res = await fetch(fullUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Collector ${path} returned HTTP ${res.status}`);
      return await res.json();
    },
    [collectorUrl],
  );

  const fetchData = useCallback(
    async (projectToFetch = selectedProject) => {
      const reqId = ++activeRequestRef.current;
      setLoading(true);
      setError(null);
      try {
        const q = projectToFetch ? `?project=${encodeURIComponent(projectToFetch)}` : "";
        const statsPromise = fetchCollector(`/stats${q}`);
        const tracesPromise = fetchCollector(`/traces${q ? `${q}&` : "?"}limit=100`);

        const [statsResult, tracesResult] = await Promise.allSettled([statsPromise, tracesPromise]);

        // Discard result if another request was triggered in the meantime
        if (reqId !== activeRequestRef.current) return;

        if (statsResult.status === "fulfilled") {
          setStats(statsResult.value as CollectorStats);
        } else {
          throw new Error(statsResult.reason?.message || "Failed to fetch stats");
        }

        if (tracesResult.status === "fulfilled" && Array.isArray(tracesResult.value)) {
          setTraces(tracesResult.value as TraceSpan[]);
        } else {
          setTraces([]);
        }
      } catch (err) {
        if (reqId === activeRequestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (reqId === activeRequestRef.current) {
          setLoading(false);
        }
      }
    },
    [fetchCollector, selectedProject],
  );

  const fetchProjects = useCallback(async () => {
    try {
      const list = (await fetchCollector("/projects")) as string[];
      if (Array.isArray(list) && list.length > 0) {
        const sorted = [...list].sort();
        setProjects(sorted);
        if (!selectedProject && sorted.includes("cld")) {
          setSelectedProject("cld");
        }
      }
    } catch {
      // ignore projects listing failure
    }
  }, [fetchCollector, selectedProject]);

  // Initial load
  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Project change load
  useEffect(() => {
    void fetchData(selectedProject);
  }, [fetchData, selectedProject]);

  const handleSelectProject = (proj: string) => {
    setSelectedProject(proj);
    setProjectDropdownOpen(false);
    setProjectSearchQuery("");
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("openrind_haloop_selected_project", proj);
      } catch {}
    }
  };

  // Filtered projects for the search dropdown
  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) return projects;
    const q = projectSearchQuery.toLowerCase().trim();
    return projects.filter((p) => p.toLowerCase().includes(q));
  }, [projects, projectSearchQuery]);

  // Real data-driven latency and token progression from traces
  const telemetryProgression = useMemo(() => {
    if (!traces || traces.length === 0) return [];
    // Chronological order (oldest to newest)
    const sorted = [...traces].sort((a, b) => {
      return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
    });

    const points = sorted.map((t, idx) => {
      const attrs = t.attributes || {};
      const latencyMs = Number(attrs["w8.latency_ms"] || 0);
      const promptTok = Number(attrs["llm.token_count.prompt"] || attrs["inference.llm.input_tokens"] || 0);
      const compTok = Number(attrs["llm.token_count.completion"] || attrs["inference.llm.output_tokens"] || 0);
      const rawPrompt = attrs["llm.input_messages.0.message.content"] || t.name || `Call #${idx + 1}`;
      const label = typeof rawPrompt === "string" ? (rawPrompt.length > 20 ? rawPrompt.slice(0, 18) + "…" : rawPrompt) : `Call #${idx + 1}`;

      return {
        id: idx + 1,
        name: label,
        latencyMs: Math.round(latencyMs),
        promptTokens: promptTok,
        completionTokens: compTok,
        totalTokens: promptTok + compTok,
      };
    });

    // When there is only 1 single turn, duplicate into 2 points so AreaChart renders a solid continuous bar/line instead of a lone dot
    if (points.length === 1) {
      const single = points[0];
      return [
        { ...single, id: 1, name: "Turn 1 (Start)" },
        { ...single, id: 2, name: single.name },
      ];
    }

    return points;
  }, [traces]);

  const totalSessions = stats?.total_sessions || (traces.length > 0 ? new Set(traces.map(t => t.attributes?.["inference.session_id"] || t.trace_id)).size : 0);
  const favoriteModel = stats?.favorite_model || "None yet";
  const handsOffMedian = stats?.hands_off_median_s || 0;
  const handsOffP90 = stats?.hands_off_p90_s || 0;
  const totalCost = stats?.total_cost_usd || 0;
  const interventionDensity = stats?.intervention_density || 0;
  const compactionsCount = stats?.compactions_count || 0;
  const admittedMistakes = stats?.warnings?.admitted_mistakes || 0;
  const toolFailures = stats?.warnings?.repeated_tool_failures || 0;

  // Real Average latency
  const avgLatency = useMemo(() => {
    const latencies = traces.map(t => Number(t.attributes?.["w8.latency_ms"] || 0)).filter(l => l > 0);
    if (latencies.length === 0) return 0;
    return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  }, [traces]);

  return (
    <div className="space-y-6 text-gray-12">
      {/* Top Banner: What your agents did */}
      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-gray-12">
                What your agents did
              </h2>
              <span className="flex items-center gap-1.5 rounded-full border border-green-7/50 bg-green-3/30 px-2.5 py-0.5 text-[11px] font-medium text-green-11">
                <span className="h-1.5 w-1.5 rounded-full bg-green-9 animate-pulse" />
                Live: {collectorUrl.replace(/^https?:\/\//, "")}
              </span>
            </div>
            <p className="text-xs text-gray-10">
              {totalSessions} sessions · {stats?.spans || traces.length} trace spans · favorite{" "}
              <span className="font-mono text-gray-12">{favoriteModel}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Custom Searchable Project Dropdown Menu (Bounded strictly inside app) */}
            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                className="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-subtle px-3 py-1.5 text-xs text-gray-12 transition-colors hover:border-dls-border-hover focus:outline-none"
                onClick={() => setProjectDropdownOpen((prev) => !prev)}
                title="Select project"
              >
                <Folder size={14} className="text-purple-10 shrink-0" />
                <span className="font-medium text-gray-9 text-[11px] uppercase tracking-wider">PROJECT:</span>
                <span className="font-semibold text-gray-12 max-w-[140px] truncate">{selectedProject}</span>
                <ChevronDown
                  size={13}
                  className={`text-gray-9 transition-transform duration-150 ${projectDropdownOpen ? "rotate-180" : ""}`}
                />
              </button>

              {projectDropdownOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 rounded-2xl border border-dls-border bg-dls-surface p-2 shadow-2xl space-y-2 backdrop-blur-md">
                  {/* Search Input */}
                  <div className="relative">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-8" />
                    <input
                      type="text"
                      value={projectSearchQuery}
                      onChange={(e) => setProjectSearchQuery(e.target.value)}
                      placeholder="Search projects..."
                      autoFocus
                      className="w-full rounded-xl border border-dls-border bg-dls-subtle/70 py-1.5 pl-8 pr-3 text-xs text-gray-12 placeholder-gray-8 outline-none focus:border-purple-8"
                    />
                  </div>

                  {/* Scrollable Project List */}
                  <div className="max-h-56 overflow-y-auto space-y-0.5 pr-1">
                    {filteredProjects.length === 0 ? (
                      <div className="p-3 text-center text-xs text-gray-8">No matching projects</div>
                    ) : (
                      filteredProjects.map((p) => {
                        const isSelected = p === selectedProject;
                        return (
                          <button
                            key={p}
                            type="button"
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                              isSelected
                                ? "bg-purple-3/50 text-purple-11 font-semibold"
                                : "text-gray-11 hover:bg-dls-surface-hover hover:text-gray-12"
                            }`}
                            onClick={() => handleSelectProject(p)}
                          >
                            <span className="truncate max-w-[200px]">{p}</span>
                            {isSelected && <Check size={13} className="text-purple-10 shrink-0" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => void fetchData(selectedProject)}
              disabled={loading}
              title="Refresh live metrics"
            >
              <RefreshCw size={12} className={`mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-7/60 bg-red-3/30 p-3 text-xs text-red-11 flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-10" />
            <div className="space-y-0.5">
              <span className="font-semibold">Collector status:</span> {error}
            </div>
          </div>
        )}

        {/* 4 Real KPI Overview Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* 1. Hands-Off Median */}
          <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-10">
              <span className="font-medium">Hands-Off Median</span>
              <Clock size={14} className="text-purple-10" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-gray-12">
              {formatSeconds(handsOffMedian)}
            </div>
            <p className="text-[11px] text-gray-9 leading-relaxed">
              p90: {formatSeconds(handsOffP90)} · Continuous autonomous agent run time without human intervention
            </p>
          </div>

          {/* 2. Intervention Density */}
          <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-10">
              <span className="font-medium">Intervention Density</span>
              <TrendingUp size={14} className="text-blue-10" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-gray-12">
              {interventionDensity} <span className="text-xs font-normal text-gray-9">/ 50 calls</span>
            </div>
            <p className="text-[11px] text-gray-9 leading-relaxed">
              Prompts needed per 50 tool executions. Lower numbers mean higher task autonomy
            </p>
          </div>

          {/* 3. API-Equivalent Spend */}
          <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-10">
              <span className="font-medium">API-Equivalent Spend</span>
              <Coins size={14} className="text-amber-10" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-gray-12">
              {formatCost(totalCost)}
            </div>
            <p className="text-[11px] text-gray-9 leading-relaxed">
              Estimated dollar cost computed from published retail token rates across all models
            </p>
          </div>

          {/* 4. Context Compactions */}
          <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-10">
              <span className="font-medium">Context Compactions</span>
              <Layers size={14} className="text-green-10" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-gray-12">
              {compactionsCount}{" "}
              <span className="text-xs font-normal text-gray-9">
                in {stats?.spans || traces.length} spans
              </span>
            </div>
            <p className="text-[11px] text-gray-9 leading-relaxed">
              Automatic context compressions recorded during extended interactive sessions
            </p>
          </div>
        </div>

        {/* Warning & Mistake Indicators Strip */}
        <div className="rounded-2xl border border-dls-border bg-dls-subtle/40 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-3 text-red-11">
              <AlertTriangle size={12} />
            </div>
            <span className="font-medium text-gray-12">Session Warning Indicators:</span>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-gray-11">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-red-9" />
              <span>Admitted Mistakes:</span>
              <span className="font-semibold text-gray-12">{admittedMistakes}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-9" />
              <span>Tool Failures:</span>
              <span className="font-semibold text-gray-12">{toolFailures}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-purple-9" />
              <span>Context Compactions:</span>
              <span className="font-semibold text-gray-12">{compactionsCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Real Data Graphs: Latency per Call & Token Volume Progression */}
      {telemetryProgression.length > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Graph 1: Latency Progression per Call */}
          <div className={`${settingsPanelClass} space-y-3`}>
            <div className="flex items-center justify-between border-b border-dls-border pb-2.5">
              <div>
                <h3 className="text-sm font-semibold text-gray-12">Model Response Latency (ms)</h3>
                <p className="text-[11px] text-gray-9">Execution time per call across sequential turns</p>
              </div>
              <div className="text-xs font-mono font-semibold text-purple-11">
                Avg: {avgLatency}ms
              </div>
            </div>

            <div className="h-56 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={telemetryProgression} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="latencyGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a855f7" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#252733" vertical={false} />
                  <XAxis dataKey="id" stroke="#71717a" fontSize={10} tickLine={false} />
                  <YAxis stroke="#71717a" fontSize={10} tickLine={false} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: 8, fontSize: 12 }}
                    formatter={(val: any) => [`${val} ms`, "Latency"]}
                    labelFormatter={(id) => `Turn #${id}`}
                  />
                  <Area
                    type="linear"
                    dataKey="latencyMs"
                    stroke="#a855f7"
                    strokeWidth={2}
                    fill="url(#latencyGrad)"
                    dot={{ r: 3, fill: "#a855f7" }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Graph 2: Context Token Window Progression */}
          <div className={`${settingsPanelClass} space-y-3`}>
            <div className="flex items-center justify-between border-b border-dls-border pb-2.5">
              <div>
                <h3 className="text-sm font-semibold text-gray-12">Context Token Volume per Turn</h3>
                <p className="text-[11px] text-gray-9">Prompt context accumulation and completion token output</p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-mono">
                <span className="flex items-center gap-1 text-teal-11">
                  <span className="h-2 w-2 rounded-full bg-teal-9" /> Prompt Tokens
                </span>
                <span className="flex items-center gap-1 text-purple-11">
                  <span className="h-2 w-2 rounded-full bg-purple-9" /> Completion
                </span>
              </div>
            </div>

            <div className="h-56 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={telemetryProgression} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="promptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#14b8a6" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="compGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a855f7" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#252733" vertical={false} />
                  <XAxis dataKey="id" stroke="#71717a" fontSize={10} tickLine={false} />
                  <YAxis stroke="#71717a" fontSize={10} tickLine={false} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(id) => `Turn #${id}`}
                  />
                  <Area
                    type="linear"
                    dataKey="promptTokens"
                    stackId="1"
                    stroke="#14b8a6"
                    strokeWidth={1.8}
                    fill="url(#promptGrad)"
                    dot={{ r: 2.5, fill: "#14b8a6" }}
                    isAnimationActive={false}
                  />
                  <Area
                    type="linear"
                    dataKey="completionTokens"
                    stackId="1"
                    stroke="#a855f7"
                    strokeWidth={1.8}
                    fill="url(#compGrad)"
                    dot={{ r: 2.5, fill: "#a855f7" }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Model Token Usage & Published Pricing Table */}
      {stats?.by_model && Object.keys(stats.by_model).length > 0 && (
        <div className={`${settingsPanelClass} space-y-3`}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-12">Model Token Usage & Published Pricing</h3>
            <span className="text-[11px] text-gray-9">Retail API Rates Reference</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-dls-border text-gray-8 font-mono text-[11px]">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Requests</th>
                  <th className="pb-2 font-medium">Prompt Tokens</th>
                  <th className="pb-2 font-medium">Output Tokens</th>
                  <th className="pb-2 font-medium">Latency (p50)</th>
                  <th className="pb-2 font-medium text-right">API Cost (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dls-border/40 text-gray-11 font-mono">
                {Object.entries(stats.by_model).map(([modelName, mData]) => (
                  <tr key={modelName} className="hover:bg-dls-surface-hover/30">
                    <td className="py-2.5 font-sans font-medium text-gray-12">{modelName}</td>
                    <td className="py-2.5">{mData.count}</td>
                    <td className="py-2.5">{mData.input_tokens ? mData.input_tokens.toLocaleString() : "—"}</td>
                    <td className="py-2.5">{mData.output_tokens ? mData.output_tokens.toLocaleString() : "—"}</td>
                    <td className="py-2.5">
                      {mData.latency_ms?.p50 ? `${mData.latency_ms.p50}ms` : "—"}
                    </td>
                    <td className="py-2.5 text-right font-semibold text-gray-12">
                      {formatCost(mData.cost_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Real Recorded Trajectories & Spans Table */}
      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-12">Recorded Trajectories & Spans</h3>
            <p className="text-xs text-gray-9">
              Showing real execution spans, prompt contents, and latency from {collectorUrl}
            </p>
          </div>
          <Button
            variant="outline"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.open("http://136.112.93.84:3000/", "_blank");
              }
            }}
          >
            <ExternalLink size={12} className="mr-1.5" /> Open Web Platform
          </Button>
        </div>

        {traces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-dls-border p-8 text-center text-xs text-gray-9">
            {loading ? "Loading trace spans from collector…" : "No spans captured for this project yet. Run an agent or demonstration task."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-dls-border text-gray-8">
                  <th className="pb-2 font-medium">Session / Trace ID</th>
                  <th className="pb-2 font-medium">Kind</th>
                  <th className="pb-2 font-medium">Prompt / Action</th>
                  <th className="pb-2 font-medium">Latency</th>
                  <th className="pb-2 font-medium">Tokens</th>
                  <th className="pb-2 font-medium">Stop Reason</th>
                  <th className="pb-2 font-medium">Warnings</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                  <th className="pb-2 font-medium text-right">Screen Frame</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dls-border/40 text-gray-11">
                {traces.map((t, idx) => {
                  const attrs = t.attributes || {};
                  const isMistake = Boolean(attrs["warning.admitted_mistake"]);
                  const isCompacted = Boolean(attrs["context_compaction"]);
                  const stopReason = attrs["stop_reason"] || "done";
                  const costUsd = attrs["llm.cost_usd"];
                  const latencyMs = attrs["w8.latency_ms"];
                  const pTokens = attrs["llm.token_count.prompt"] || attrs["inference.llm.input_tokens"];
                  const cTokens = attrs["llm.token_count.completion"] || attrs["inference.llm.output_tokens"];

                  // Extract prompt message or action name
                  let promptText = attrs["llm.input_messages.0.message.content"] || attrs["tool.name"] || t.name;
                  if (typeof promptText === "string" && promptText.startsWith("[")) {
                    try {
                      const parsed = JSON.parse(promptText);
                      if (Array.isArray(parsed) && parsed[0]?.content) promptText = parsed[0].content;
                    } catch {}
                  }

                  // Check if there is an artifact / screen frame
                  const artifactUrl =
                    attrs["artifactUrl"] ||
                    attrs["frame_after"]?.artifactUrl ||
                    attrs["frame_before"]?.artifactUrl ||
                    (attrs["artifactId"] ? `${collectorUrl}/artifacts/${attrs["artifactId"]}` : null);

                  return (
                    <tr key={`${t.span_id || t.trace_id}-${idx}`} className="hover:bg-dls-surface-hover/30 transition-colors">
                      <td className="py-2.5 font-mono text-[11px] text-gray-12">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate max-w-[120px]">{t.trace_id?.slice(0, 12)}…</span>
                          {isCompacted && (
                            <span
                              className="rounded bg-purple-3 px-1 py-0.5 text-[9px] font-bold text-purple-11"
                              title="Context Compaction occurred in this session"
                            >
                              1 ↺
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-2.5 font-medium">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase font-bold tracking-wider ${
                            attrs["inference.observation_kind"] === "LLM"
                              ? "bg-blue-3/50 text-blue-11"
                              : attrs["inference.observation_kind"] === "TOOL"
                                ? "bg-amber-3/50 text-amber-11"
                                : "bg-gray-3/50 text-gray-11"
                          }`}
                        >
                          {attrs["inference.observation_kind"] || t.kind || "SPAN"}
                        </span>
                      </td>

                      <td className="py-2.5 font-medium text-gray-12 truncate max-w-[240px]" title={String(promptText)}>
                        {String(promptText)}
                      </td>

                      <td className="py-2.5 font-mono text-gray-11">
                        {latencyMs ? `${Math.round(latencyMs)}ms` : "—"}
                      </td>

                      <td className="py-2.5 font-mono text-[11px] text-gray-9">
                        {pTokens || cTokens ? `${pTokens ?? 0} in / ${cTokens ?? 0} out` : "—"}
                      </td>

                      <td className="py-2.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                            stopReason === "done"
                              ? "bg-green-3 text-green-11 border border-green-7/40"
                              : stopReason === "token_limit"
                                ? "bg-purple-3 text-purple-11 border border-purple-7/40"
                                : stopReason === "timeout"
                                  ? "bg-red-3 text-red-11 border border-red-7/40"
                                  : "bg-gray-3 text-gray-10 border border-gray-7/40"
                          }`}
                        >
                          {stopReason}
                        </span>
                      </td>

                      <td className="py-2.5">
                        <div className="flex items-center gap-1">
                          {isMistake && (
                            <span
                              className="flex items-center gap-1 text-[10px] font-medium text-red-11 bg-red-3/40 border border-red-7/40 px-1.5 py-0.5 rounded"
                              title="Agent admitted mistake / concession detected"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-red-9" />
                              Mistake
                            </span>
                          )}
                          {!isMistake && <span className="text-gray-7">—</span>}
                        </div>
                      </td>

                      <td className="py-2.5 text-right font-mono font-medium text-gray-12">
                        {costUsd !== undefined ? formatCost(costUsd) : "—"}
                      </td>

                      <td className="py-2.5 text-right">
                        {artifactUrl ? (
                          <Button
                            variant="outline"
                            className="h-6 rounded-md px-2 text-[10px]"
                            onClick={() =>
                              setPreviewArtifact({
                                url: artifactUrl,
                                title: `Screen Observation (${attrs["artifactId"] || "Frame"})`,
                                meta: {
                                  cursor: attrs["cursor"],
                                  window: attrs["activeWindow"],
                                  trigger: attrs["trigger"],
                                },
                              })
                            }
                          >
                            <ImageIcon size={11} className="mr-1 text-purple-10" />
                            View Frame
                          </Button>
                        ) : (
                          <span className="text-gray-6 text-[10px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Artifact / Screenshot Preview Modal */}
      {previewArtifact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="relative max-h-[90vh] w-full max-w-4xl rounded-3xl border border-dls-border bg-dls-surface p-6 shadow-2xl space-y-4 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between border-b border-dls-border pb-3">
              <div className="flex items-center gap-2">
                <Monitor size={18} className="text-purple-10" />
                <h3 className="text-sm font-semibold text-gray-12">{previewArtifact.title}</h3>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-gray-9 hover:bg-dls-surface-hover hover:text-gray-12"
                onClick={() => setPreviewArtifact(null)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-auto rounded-xl border border-dls-border bg-black/40 p-2 flex items-center justify-center min-h-[350px]">
              <img
                src={previewArtifact.url}
                alt="Captured desktop screen"
                className="max-h-[60vh] max-w-full rounded-lg object-contain shadow-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
