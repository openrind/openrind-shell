import { useState, useCallback, useEffect, useRef } from 'react';
import type { BrowserPanelState, BrowserProviderKind, BrowserSessionStatus, BrowserTab } from './types';

const defaultTab: BrowserTab = {
  pageId: 'bp_main',
  url: 'about:blank',
  title: 'New Tab',
  documentGeneration: 1,
};

const defaultState: BrowserPanelState = {
  isOpen: false,
  viewId: undefined,
  provider: 'desktop-webview',
  status: 'idle',
  currentUrl: 'about:blank',
  trustedOrigin: null,
  tabs: [defaultTab],
  activeTabId: 'bp_main',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  handoff: { active: false },
  artifacts: [],
  error: null,
};

export function useBrowserStore(conversationId: string, sandboxName?: string) {
  const [state, setState] = useState<BrowserPanelState>(defaultState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const electron = (typeof window !== 'undefined' ? (window as any).__OPENRIND_DESKTOP_ELECTRON__ : undefined);

  const startSession = useCallback(async (provider: BrowserProviderKind, initialUrl?: string) => {
    setState(s => ({ ...s, status: 'starting', provider, error: null }));
    try {
      if (electron?.browser?.start) {
        const res = await electron.browser.start({
          sessionId: `bs_${Date.now()}`,
          conversationId,
          provider,
          initialUrl: initialUrl || 'about:blank',
        });
        const initialTab: BrowserTab = {
          pageId: 'bp_main',
          url: initialUrl || 'about:blank',
          title: initialUrl && initialUrl !== 'about:blank' ? initialUrl.replace(/^https?:\/\//, '') : 'New Tab',
          documentGeneration: 1,
        };
        setState(s => ({
          ...s,
          isOpen: true,
          viewId: res.viewId,
          status: 'ready',
          currentUrl: initialUrl || 'about:blank',
          trustedOrigin: initialUrl && initialUrl.startsWith('https://') ? new URL(initialUrl).origin : null,
          tabs: [initialTab],
          activeTabId: initialTab.pageId,
          handoff: { active: false },
        }));
      } else {
        // Fallback for non-electron or mock environments
        setState(s => ({ ...s, isOpen: true, status: 'ready', currentUrl: initialUrl || 'about:blank' }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, status: 'error', error: err?.message || 'Failed to start browser' }));
    }
  }, [conversationId, electron]);

  const stopSession = useCallback(async () => {
    setState(s => ({ ...s, status: 'closing' }));
    try {
      if (electron?.browser?.stop && stateRef.current.viewId) {
        await electron.browser.stop({ viewId: stateRef.current.viewId });
      }
    } catch {}
    setState(s => ({ ...defaultState, isOpen: false }));
  }, [electron]);

  const navigate = useCallback(async (url: string, forPageId?: string) => {
    if (!url) return;
    let target = url.trim();
    if (!target.startsWith('https://') && !target.startsWith('http://') && target !== 'about:blank') {
      target = `https://${target}`;
    }
    try {
      const activeId = forPageId || stateRef.current.activeTabId || stateRef.current.tabs[0]?.pageId;
      const cleanTitle = target === 'about:blank' ? 'New Tab' : target.replace(/^https?:\/\//, '');
      setState(s => ({
        ...s,
        error: null,
        currentUrl: target,
        trustedOrigin: target.startsWith('https://') ? new URL(target).origin : null,
        tabs: s.tabs.map(t => t.pageId === activeId ? { ...t, url: target, title: cleanTitle } : t),
      }));
      if (electron?.browser?.navigate && stateRef.current.viewId) {
        const res = await electron.browser.navigate({ viewId: stateRef.current.viewId, url: target });
        const finalUrl = res.url || target;
        const finalTitle = finalUrl === 'about:blank' ? 'New Tab' : finalUrl.replace(/^https?:\/\//, '');
        setState(s => ({
          ...s,
          currentUrl: finalUrl,
          tabs: s.tabs.map(t => t.pageId === activeId ? { ...t, url: finalUrl, title: finalTitle } : t),
        }));
      } else if (!stateRef.current.viewId && electron?.browser?.start) {
        await startSession(stateRef.current.provider, target);
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Navigation failed' }));
    }
  }, [electron]);

  const takeControl = useCallback(async () => {
    try {
      if (electron?.browser?.takeControl && stateRef.current.viewId) {
        const res = await electron.browser.takeControl({ viewId: stateRef.current.viewId });
        setState(s => ({
          ...s,
          status: 'human_control',
          handoff: { active: true, handoffId: res.handoffId, epoch: res.epoch },
        }));
      } else {
        setState(s => ({ ...s, status: 'human_control', handoff: { active: true } }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Take control failed' }));
    }
  }, [electron]);

  const resumeControl = useCallback(async () => {
    try {
      if (electron?.browser?.resume && stateRef.current.viewId) {
        const res = await electron.browser.resume({ viewId: stateRef.current.viewId });
        setState(s => ({
          ...s,
          status: 'ready',
          handoff: { active: false, epoch: res.epoch },
        }));
      } else {
        setState(s => ({ ...s, status: 'ready', handoff: { active: false } }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Resume control failed' }));
    }
  }, [electron]);

  const setBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    if (electron?.browser?.setBounds && stateRef.current.viewId) {
      electron.browser.setBounds({ viewId: stateRef.current.viewId, bounds }).catch(() => {});
    }
  }, [electron]);

  const setVisible = useCallback((visible: boolean) => {
    if (electron?.browser?.setVisible && stateRef.current.viewId) {
      electron.browser.setVisible({ viewId: stateRef.current.viewId, visible }).catch(() => {});
    }
    setState(s => ({ ...s, isOpen: visible }));
  }, [electron]);

  useEffect(() => {
    if (!electron?.browser?.onEvent) return;
    const unsub = electron.browser.onEvent((evt: any) => {
      if (!evt) return;
      if (evt.type === 'zoom-changed') {
        window.dispatchEvent(new Event('resize'));
        return;
      }
      // Ignore events not belonging to this panel's active conversation
      if (evt.conversationId && evt.conversationId !== conversationId) {
        return;
      }
      // If the panel already has an active viewId, ignore events from a foreign view
      if (stateRef.current.viewId && evt.viewId && evt.viewId !== stateRef.current.viewId) {
        return;
      }
      if (evt.type === 'start' || evt.type === 'navigate') {
        const url = evt.url || 'about:blank';
        const cleanTitle = url === 'about:blank' ? 'New Tab' : url.replace(/^https?:\/\//, '');
        setState(s => {
          const activeId = s.activeTabId || s.tabs[0]?.pageId || 'bp_main';
          const hasTabs = s.tabs.length > 0;
          const updatedTabs = hasTabs
            ? s.tabs.map(t => t.pageId === activeId ? { ...t, url, title: cleanTitle } : t)
            : [{ pageId: activeId, url, title: cleanTitle, documentGeneration: 1 }];
          return {
            ...s,
            error: null,
            isOpen: true,
            status: 'ready',
            viewId: evt.viewId || s.viewId,
            currentUrl: url,
            trustedOrigin: url.startsWith('https://') ? new URL(url).origin : null,
            tabs: updatedTabs,
            activeTabId: activeId,
            canGoBack: typeof evt.canGoBack === 'boolean' ? evt.canGoBack : s.canGoBack,
            canGoForward: typeof evt.canGoForward === 'boolean' ? evt.canGoForward : s.canGoForward,
            isLoading: false,
          };
        });
      } else if (evt.type === 'stop') {
        setState(s => ({
          ...s,
          isOpen: false,
          status: 'idle',
        }));
      }
    });
    return unsub;
  }, [electron]);

  const openTab = useCallback(async (url: string = 'about:blank') => {
    const newPageId = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const cleanTitle = url === 'about:blank' ? 'New Tab' : url.replace(/^https?:\/\//, '');
    const newTab: BrowserTab = {
      pageId: newPageId,
      url: url,
      title: cleanTitle,
      documentGeneration: 1,
    };
    setState(s => ({
      ...s,
      tabs: [...s.tabs, newTab],
      activeTabId: newPageId,
      currentUrl: url,
    }));
    if (stateRef.current.viewId && electron?.browser?.navigate) {
      await navigate(url, newPageId);
    } else {
      await startSession(stateRef.current.provider, url);
    }
  }, [electron, navigate, startSession]);

  const closeTab = useCallback((pageId: string) => {
    let targetUrlToNav: string | null = null;
    let targetActiveId: string | null = null;
    setState(s => {
      const remaining = s.tabs.filter(t => t.pageId !== pageId);
      if (remaining.length === 0) {
        const defaultTab: BrowserTab = { pageId: 'bp_main', url: 'about:blank', title: 'New Tab', documentGeneration: 1 };
        targetUrlToNav = 'about:blank';
        targetActiveId = 'bp_main';
        return {
          ...s,
          tabs: [defaultTab],
          activeTabId: 'bp_main',
          currentUrl: 'about:blank',
        };
      }
      const nextActive = s.activeTabId === pageId ? remaining[remaining.length - 1].pageId : s.activeTabId;
      const nextTab = remaining.find(t => t.pageId === nextActive) || remaining[0];
      targetUrlToNav = nextTab.url;
      targetActiveId = nextActive;
      return {
        ...s,
        tabs: remaining,
        activeTabId: nextActive,
        currentUrl: nextTab.url,
      };
    });
    if (targetUrlToNav !== null && stateRef.current.viewId && electron?.browser?.navigate) {
      void navigate(targetUrlToNav, targetActiveId || undefined);
    }
  }, [electron, navigate]);

  const selectTab = useCallback(async (pageId: string) => {
    const tab = stateRef.current.tabs.find(t => t.pageId === pageId);
    if (!tab) return;
    setState(s => ({
      ...s,
      activeTabId: pageId,
      currentUrl: tab.url,
    }));
    if (electron?.browser?.navigate && stateRef.current.viewId && tab.url && tab.url !== 'about:blank') {
      try {
        await electron.browser.navigate({ viewId: stateRef.current.viewId, url: tab.url });
      } catch {}
    }
  }, [electron]);

  const goBack = useCallback(async () => {
    if (electron?.browser?.goBack && stateRef.current.viewId) {
      setState(s => ({ ...s, isLoading: true }));
      try {
        await electron.browser.goBack({ viewId: stateRef.current.viewId });
      } catch {}
      setState(s => ({ ...s, isLoading: false }));
    }
  }, [electron]);

  const goForward = useCallback(async () => {
    if (electron?.browser?.goForward && stateRef.current.viewId) {
      setState(s => ({ ...s, isLoading: true }));
      try {
        await electron.browser.goForward({ viewId: stateRef.current.viewId });
      } catch {}
      setState(s => ({ ...s, isLoading: false }));
    }
  }, [electron]);

  const reload = useCallback(async () => {
    if (electron?.browser?.reload && stateRef.current.viewId) {
      setState(s => ({ ...s, isLoading: true }));
      try {
        await electron.browser.reload({ viewId: stateRef.current.viewId });
      } catch {}
      setState(s => ({ ...s, isLoading: false }));
    } else if (stateRef.current.currentUrl && stateRef.current.currentUrl !== 'about:blank') {
      await navigate(stateRef.current.currentUrl);
    }
  }, [electron, navigate]);

  return {
    state,
    startSession,
    stopSession,
    navigate,
    goBack,
    goForward,
    reload,
    takeControl,
    resumeControl,
    setBounds,
    setVisible,
    openTab,
    closeTab,
    selectTab,
  };
}
