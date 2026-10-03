import React, { useRef, useEffect, useState } from 'react';
import type { BrowserPanelState, BrowserProviderKind } from '../types';

export interface BrowserPanelProps {
  state: BrowserPanelState;
  onStart: (provider: BrowserProviderKind, url?: string) => Promise<void>;
  onStop: () => Promise<void>;
  onNavigate?: (url: string) => Promise<void>;
  onTakeControl: () => Promise<void>;
  onResume: () => Promise<void>;
  onSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  onClosePanel?: () => void;
}

export function BrowserPanel({
  state,
  onStart,
  onStop,
  onNavigate,
  onTakeControl,
  onResume,
  onSetBounds,
  onClosePanel,
}: BrowserPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<BrowserProviderKind>(state.provider || 'local-chromium');
  const [inputUrl, setInputUrl] = useState(state.currentUrl === 'about:blank' ? '' : state.currentUrl);

  useEffect(() => {
    if (state.currentUrl && state.currentUrl !== 'about:blank') {
      setInputUrl(state.currentUrl);
    }
  }, [state.currentUrl]);

  // Sync geometry on resize/scroll/DIP changes without infinite loops
  useEffect(() => {
    if (!containerRef.current || !state.isOpen) return;

    let rafId: number | null = null;
    const updateGeometry = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (
        lastBoundsRef.current &&
        lastBoundsRef.current.x === next.x &&
        lastBoundsRef.current.y === next.y &&
        lastBoundsRef.current.width === next.width &&
        lastBoundsRef.current.height === next.height
      ) {
        return;
      }
      lastBoundsRef.current = next;
      onSetBounds(next);
    };

    const scheduleUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateGeometry();
      });
    };

    scheduleUpdate();
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [state.isOpen, onSetBounds]);

  const isHumanControl = state.status === 'human_control';
  const isExecuting = state.status === 'executing';
  const isRunning = state.status !== 'idle' && state.status !== 'closed' && state.status !== 'error';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: '#1e1e24',
      color: '#e4e4e7',
      borderLeft: '1px solid #2e2e38',
      fontSize: '13px',
      overflow: 'hidden',
    }}>
      {/* Top Header Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid #2e2e38',
        backgroundColor: '#18181b',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 600 }}>Browser Agent</span>
          <select
            value={selectedProvider}
            disabled={isRunning}
            onChange={e => setSelectedProvider(e.target.value as BrowserProviderKind)}
            style={{
              backgroundColor: '#27272a',
              color: '#e4e4e7',
              border: '1px solid #3f3f46',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '11px',
            }}
          >
            <option value="local-chromium">Local Chromium</option>
            <option value="desktop-webview">Desktop Webview</option>
            <option value="browserbase">Cloud (Browserbase)</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {!isRunning ? (
            <button
              onClick={() => onStart(selectedProvider, inputUrl || undefined)}
              style={{
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 10px',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              Start
            </button>
          ) : (
            <button
              onClick={() => onStop()}
              style={{
                backgroundColor: '#dc2626',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 10px',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              Stop
            </button>
          )}

          {onClosePanel && (
            <button
              onClick={onClosePanel}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#71717a',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* URL & Navigation Strip */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '6px 12px',
        gap: '8px',
        backgroundColor: '#222227',
        borderBottom: '1px solid #2e2e38',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          flex: 1,
          backgroundColor: '#18181b',
          borderRadius: '4px',
          border: '1px solid #3f3f46',
          padding: '2px 8px',
          gap: '6px',
        }}>
          <span style={{ color: state.currentUrl.startsWith('https://') ? '#10b981' : '#a1a1aa' }}>
            {state.currentUrl.startsWith('https://') ? '🔒' : '🌐'}
          </span>
          <input
            type="text"
            value={inputUrl}
            placeholder="Enter https:// URL and press Enter..."
            onChange={e => setInputUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && inputUrl) {
                if (isRunning && onNavigate) {
                  void onNavigate(inputUrl);
                } else {
                  void onStart(selectedProvider, inputUrl);
                }
              }
            }}
            style={{
              flex: 1,
              backgroundColor: 'transparent',
              border: 'none',
              color: '#f4f4f5',
              outline: 'none',
              fontSize: '12px',
            }}
          />
          {inputUrl ? (
            <button
              onClick={() => {
                if (isRunning && onNavigate) void onNavigate(inputUrl);
                else void onStart(selectedProvider, inputUrl);
              }}
              style={{
                backgroundColor: '#3f3f46',
                color: '#e4e4e7',
                border: 'none',
                borderRadius: '3px',
                padding: '1px 6px',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Go
            </button>
          ) : null}
        </div>

        {/* Human Handoff Controls */}
        {isRunning && (
          <div>
            {!isHumanControl ? (
              <button
                onClick={() => onTakeControl()}
                title="Pause AI automation and take manual control of the page"
                style={{
                  backgroundColor: '#f59e0b',
                  color: '#000000',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Take Control
              </button>
            ) : (
              <button
                onClick={() => onResume()}
                title="Release manual control and let AI agent resume"
                style={{
                  backgroundColor: '#10b981',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Resume AI
              </button>
            )}
          </div>
        )}
      </div>

      {/* Human Handoff / Automation Status Banner */}
      {isRunning && (
        <div style={{
          padding: '6px 12px',
          fontSize: '12px',
          backgroundColor: isHumanControl ? '#451a03' : isExecuting ? '#1e1b4b' : '#14532d',
          color: isHumanControl ? '#fde68a' : isExecuting ? '#c7d2fe' : '#bbf7d0',
          borderBottom: '1px solid #2e2e38',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>
            {isHumanControl
              ? '👤 You are in control. Complete your login or actions, then click Resume AI.'
              : isExecuting
              ? '🤖 AI Agent is automating page actions...'
              : '⚡ Browser is ready for agent instructions.'}
          </span>
          <span style={{ fontSize: '11px', opacity: 0.8 }}>
            Epoch {state.handoff.epoch || 1}
          </span>
        </div>
      )}

      {/* Error Banner */}
      {state.error && (
        <div style={{
          backgroundColor: '#450a0a',
          color: '#fca5a5',
          padding: '6px 12px',
          fontSize: '12px',
          borderBottom: '1px solid #7f1d1d',
        }}>
          ⚠️ {state.error}
        </div>
      )}

      {/* Embedded View Geometry Container */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: '100%',
          backgroundColor: '#09090b',
          position: 'relative',
        }}
      >
        {!isRunning && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#71717a',
            gap: '8px',
          }}>
            <span style={{ fontSize: '32px' }}>🧭</span>
            <span>Browser is currently stopped</span>
            <span style={{ fontSize: '11px' }}>Click Start to launch browser session</span>
          </div>
        )}
      </div>

      {/* Footer: Staged Artifacts summary */}
      {state.artifacts.length > 0 && (
        <div style={{
          padding: '6px 12px',
          backgroundColor: '#18181b',
          borderTop: '1px solid #2e2e38',
          fontSize: '11px',
          display: 'flex',
          gap: '12px',
          color: '#a1a1aa',
        }}>
          <span>Artifacts: {state.artifacts.length}</span>
          <span>Screenshots: {state.artifacts.filter(a => a.mimeType.startsWith('image/')).length}</span>
        </div>
      )}
    </div>
  );
}
