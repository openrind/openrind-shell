export type BrowserProviderKind = 'local-chromium' | 'browserbase' | 'desktop-webview';

export type BrowserSessionStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'executing'
  | 'human_control'
  | 'closing'
  | 'closed'
  | 'error';

export interface BrowserTab {
  pageId: string;
  url: string;
  title?: string;
  documentGeneration: number;
}

export interface BrowserArtifact {
  artifactId: string;
  filename: string;
  mimeType: string;
  byteCount: number;
}

export interface BrowserHandoffState {
  active: boolean;
  handoffId?: string;
  epoch?: number;
}

export interface BrowserPanelState {
  isOpen: boolean;
  viewId?: string;
  provider: BrowserProviderKind;
  status: BrowserSessionStatus;
  currentUrl: string;
  trustedOrigin: string | null;
  tabs: BrowserTab[];
  activeTabId: string | null;
  handoff: BrowserHandoffState;
  artifacts: BrowserArtifact[];
  error: string | null;
}
