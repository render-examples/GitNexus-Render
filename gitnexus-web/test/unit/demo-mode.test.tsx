/**
 * Demo mode UI gating (per-session model).
 *
 * In demo mode visitors may still analyze their own repositories, so the
 * analyze/upload affordances stay visible. What changes is per-repo ownership:
 *   - Header: re-analyze + delete render only for repos the session added
 *     (`demoOwned: true`); seed repos hide them. "Analyze new" stays visible.
 *   - RepoLanding: the analyzer form always renders; in demo mode the footer
 *     shows the session-private banner instead of the normal hint.
 *
 * The backend guard (test/unit/demo-store + test/integration/server-demo-mode)
 * is the actual enforcement boundary; this only covers the UI affordances.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../../src/components/Header';
import { RepoLanding } from '../../src/components/RepoLanding';
import type { BackendRepo } from '../../src/services/backend-client';

// Mutable app-state stub so each test can flip `demo`.
const appState: Record<string, unknown> = {};
vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => appState,
}));

vi.mock('../../src/components/EmbeddingStatus', () => ({
  EmbeddingStatus: () => <div data-testid="embedding-status" />,
}));
vi.mock('../../src/components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));
vi.mock('../../src/components/RepoAnalyzer', () => ({
  RepoAnalyzer: () => <div data-testid="repo-analyzer" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'header:deleteRepo') return `Delete ${options?.repoName ?? ''}`;
      if (key === 'header:reanalyzeRepo') return `Re-analyze ${options?.repoName ?? ''}`;
      if (key === 'header:analyzeNew') return 'Analyze new';
      return key;
    },
  }),
}));

function makeRepo(index: number, demoOwned?: boolean): BackendRepo {
  return {
    name: index === 0 ? 'reels' : `repo-${index}`,
    path: `/tmp/repo-${index}`,
    indexedAt: '2024-01-01T00:00:00Z',
    stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
    ...(demoOwned === undefined ? {} : { demoOwned }),
  };
}

const baseHeaderState = {
  projectName: 'reels',
  currentRepo: '/tmp/repo-0',
  graph: null,
  graphMode: 'full',
  openChatPanel: vi.fn(),
  isRightPanelOpen: false,
  rightPanelTab: 'chat',
  setSettingsPanelOpen: vi.fn(),
  setHelpDialogBoxOpen: vi.fn(),
};

afterEach(() => {
  for (const k of Object.keys(appState)) delete appState[k];
  vi.clearAllMocks();
});

describe('Header — demo mode gating', () => {
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /reels/i }));

  it('shows delete/re-analyze only for session-owned repos, and keeps "Analyze new"', () => {
    Object.assign(appState, baseHeaderState, { demo: true });
    // repo-0 is a seed (not owned); repo-1 was added by this session (owned).
    render(<Header availableRepos={[makeRepo(0, false), makeRepo(1, true)]} />);
    openMenu();

    // Analyze-new stays available in demo mode (visitors can add their own).
    expect(screen.getByText('Analyze new')).toBeInTheDocument();
    // Exactly one row (the owned repo) exposes mutation controls.
    expect(screen.getAllByTestId('repo-switcher-reanalyze')).toHaveLength(1);
    expect(screen.getAllByTestId('repo-switcher-delete')).toHaveLength(1);
  });

  it('shows all controls for every repo when demo is false', () => {
    Object.assign(appState, baseHeaderState, { demo: false });
    render(<Header availableRepos={[makeRepo(0), makeRepo(1)]} />);
    openMenu();

    expect(screen.getAllByTestId('repo-switcher-reanalyze')).toHaveLength(2);
    expect(screen.getAllByTestId('repo-switcher-delete')).toHaveLength(2);
    expect(screen.getByText('Analyze new')).toBeInTheDocument();
  });
});

describe('RepoLanding — demo mode', () => {
  it('keeps the analyzer form and shows the session-private banner when demo is true', () => {
    Object.assign(appState, { demo: true });
    render(
      <RepoLanding repos={[makeRepo(0)]} onSelectRepo={vi.fn()} onAnalyzeComplete={vi.fn()} />,
    );

    expect(screen.getByTestId('landing-repo-card')).toBeInTheDocument();
    expect(screen.getByTestId('repo-analyzer')).toBeInTheDocument();
    expect(screen.getByText('demo.sessionBanner')).toBeInTheDocument();
  });

  it('shows the analyzer form and the normal footer when demo is false', () => {
    Object.assign(appState, { demo: false });
    render(
      <RepoLanding repos={[makeRepo(0)]} onSelectRepo={vi.fn()} onAnalyzeComplete={vi.fn()} />,
    );

    expect(screen.getByTestId('repo-analyzer')).toBeInTheDocument();
    expect(screen.getByText('landing.footer')).toBeInTheDocument();
  });
});
