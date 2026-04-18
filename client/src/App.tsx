import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import AgentGrid, { type GridLayout } from './components/AgentGrid';
import SharedContentView from './components/SharedContent';
import ActivityFeed from './components/ActivityFeed';
import ProjectWiki from './components/ProjectWiki';
import MessagesPanel from './components/MessagesPanel';
import CommandPalette from './components/CommandPalette';
import CreateProjectModal from './components/CreateProjectModal';
import CreateAgentModal from './components/CreateAgentModal';
import Ic, { MOD } from './components/Icons';
import { useWebSocket } from './hooks/useWebSocket';
import logoDark from './assets/logo_dark_sm.jpg';
import logoLight from './assets/logo_light_sm.jpg';
import * as api from './api';
import type { Project, Agent } from './api';

type MainTab = 'terminals' | 'messages' | 'shared' | 'wiki' | 'activity';
type Theme = 'dark' | 'light' | 'amber' | 'mono';

const LAYOUT_ICONS: { v: GridLayout; Icon: (p: { size?: number }) => JSX.Element; title: string }[] = [
  { v: 'single', Icon: Ic.single, title: 'Single' },
  { v: '2up', Icon: Ic.twoup, title: '2-up' },
  { v: '3up', Icon: Ic.threeup, title: '3-up' },
  { v: 'grid', Icon: Ic.grid, title: 'Grid (splits & resize)' },
  { v: 'canvas', Icon: Ic.canvas, title: 'Canvas (drag & resize)' },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent[]>>(new Map());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('terminals');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('termhive:theme') as Theme) || 'dark';
  });
  const [layout, setLayout] = useState<GridLayout>(() => {
    const saved = localStorage.getItem('termhive:layout') as GridLayout | null;
    // Migrate the old 'focus' value away
    if (saved === 'focus' as GridLayout) return 'canvas' as GridLayout;
    return saved || '3up';
  });
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [contentRefresh, setContentRefresh] = useState(0);

  // Sidebar collapse + resize state
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    localStorage.getItem('termhive:sidebar-collapsed') === '1'
  );
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const n = parseInt(localStorage.getItem('termhive:sidebar-w') || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 232;
  });
  useEffect(() => {
    localStorage.setItem('termhive:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('termhive:sidebar-w', String(sidebarW));
  }, [sidebarW]);

  const onSidebarResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(420, startW + (ev.clientX - startX)));
      setSidebarW(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  };

  // Theme persistence
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('termhive:theme', theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('termhive:layout', layout);
  }, [layout]);

  // WebSocket
  const { send, wsRef } = useWebSocket((msg: { type?: string; agentId?: string; status?: string }) => {
    if (msg.type === 'content:updated') {
      setContentRefresh((n) => n + 1);
    }
    if (msg.type === 'agent:status' && msg.agentId && msg.status) {
      setAgents((prev) => {
        const next = new Map(prev);
        for (const [pid, list] of next) {
          const updated = list.map((a) =>
            a.id === msg.agentId ? { ...a, status: msg.status as Agent['status'] } : a
          );
          next.set(pid, updated);
        }
        return next;
      });
    }
  });

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
  }, []);

  const loadAgents = useCallback(async (projectId: string) => {
    const list = await api.listAgents(projectId);
    setAgents((prev) => new Map(prev).set(projectId, list));
  }, []);

  useEffect(() => { loadProjects(); }, []);

  useEffect(() => {
    if (selectedProjectId) loadAgents(selectedProjectId);
  }, [selectedProjectId]);

  // Load agents for ALL projects so sidebar can show running counts
  useEffect(() => {
    projects.forEach((p) => {
      if (!agents.has(p.id)) loadAgents(p.id);
    });
  }, [projects]);

  const projectAgents = selectedProjectId ? agents.get(selectedProjectId) || [] : [];
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const runningCount = projectAgents.filter((a) => a.status === 'running').length;
  const stoppedCount = projectAgents.filter((a) => a.status === 'stopped').length;

  // Keyboard shortcuts: ⌘K/Ctrl+K (palette), ⌘1–5 (focus agent)
  // `capture: true` fires in the capture phase so it preempts xterm's textarea
  // even when an xterm instance has focus. preventDefault + stopPropagation
  // then prevents the key from reaching xterm at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); e.stopPropagation();
        setPaletteOpen(true); return;
      }
      if (mod && e.key === '/') {
        e.preventDefault(); e.stopPropagation();
        setPaletteOpen(true); return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const i = parseInt(e.key, 10) - 1;
        const a = projectAgents[i];
        if (a) setSelectedAgentId(a.id);
        return;
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [projectAgents]);

  // Handlers
  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
    setSelectedAgentId(null);
  };

  const handleSelectAgent = (projectId: string, agentId: string) => {
    setSelectedProjectId(projectId);
    setSelectedAgentId(agentId);
    setMainTab('terminals');
  };

  const handleCreateProject = async (data: { name: string; cwd: string; description?: string }) => {
    const project = await api.createProject(data);
    setShowNewProject(false);
    await loadProjects();
    setSelectedProjectId(project.id);
  };

  const handleCreateAgent = async (data: { name: string; cli: string; cwd?: string; role?: string; flags?: Agent['flags'] }) => {
    if (!selectedProjectId) return;
    await api.createAgent(selectedProjectId, data);
    setShowNewAgent(false);
    await loadAgents(selectedProjectId);
  };

  const handleStartAgent = async (agent: Agent) => {
    await api.startAgent(agent.projectId, agent.id);
    await loadAgents(agent.projectId);
  };
  const handleStopAgent = async (agent: Agent) => {
    await api.stopAgent(agent.projectId, agent.id);
    await loadAgents(agent.projectId);
  };
  const handleRestartAgent = async (agent: Agent) => {
    await api.restartAgent(agent.projectId, agent.id);
    setTimeout(() => loadAgents(agent.projectId), 800);
  };
  const handleDeleteAgent = async (agent: Agent) => {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    await api.deleteAgent(agent.projectId, agent.id);
    if (selectedAgentId === agent.id) setSelectedAgentId(null);
    await loadAgents(agent.projectId);
  };

  const handleDeleteProject = async () => {
    if (!selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    if (!confirm(`Delete project "${project?.name}"?`)) return;
    const removeData = confirm('Also remove shared content and wiki data?');
    await api.deleteProject(selectedProjectId, removeData);
    setSelectedProjectId(null);
    setSelectedAgentId(null);
    await loadProjects();
  };

  const handleStartAll = async (projectId?: string) => {
    const pid = projectId || selectedProjectId;
    if (!pid) return;
    const list = agents.get(pid) || [];
    const stopped = list.filter((a) => a.status === 'stopped');
    await Promise.all(stopped.map((a) => api.startAgent(pid, a.id)));
    await loadAgents(pid);
  };

  const handleStopAll = async (projectId?: string) => {
    const pid = projectId || selectedProjectId;
    if (!pid) return;
    const list = agents.get(pid) || [];
    const running = list.filter((a) => a.status === 'running');
    await Promise.all(running.map((a) => api.stopAgent(pid, a.id)));
    await loadAgents(pid);
  };

  const logoImg = theme === 'light' ? logoLight : logoDark;

  const appCls = ['app'];
  if (sidebarCollapsed) appCls.push('sb-hidden');

  return (
    <div className={appCls.join(' ')} style={{ '--sidebar-w': sidebarW + 'px' } as React.CSSProperties}>
      <header className="header">
        <div className="header-l">
          <button
            className="hbtn mobile-only"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            style={{ padding: '0 6px' }}
          >
            <Ic.menu size={16} />
          </button>
          <button
            className="hbtn sb-toggle desktop-only"
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? <Ic.panelLeftOpen size={14} /> : <Ic.panelLeft size={14} />}
          </button>
          <div className="brand">
            <div className="brand-mark">
              <img src={logoImg} alt="TermHive" />
            </div>
            <span>TermHive</span>
          </div>
          {selectedProject && (
            <div className="breadcrumb">
              <span className="sep">/</span>
              <span className="proj">{selectedProject.name}</span>
              <span className="proj-meta">{selectedProject.cwd}</span>
            </div>
          )}
        </div>
        <div className="header-r">
          <button className="hbtn kbd" onClick={() => setPaletteOpen(true)}>
            <Ic.search size={12} />
            <span>Search</span>
            <kbd>{MOD}K</kbd>
          </button>
          <div className="layout-seg" role="tablist" aria-label="Layout">
            {LAYOUT_ICONS.map(({ v, Icon, title }) => (
              <button
                key={v}
                className={layout === v ? 'active' : ''}
                title={title}
                onClick={() => setLayout(v)}
              >
                <Icon size={13} />
              </button>
            ))}
          </div>
          <button
            className="hbtn"
            title="Toggle theme"
            onClick={() =>
              setTheme((t) => (t === 'dark' ? 'light' : t === 'light' ? 'amber' : t === 'amber' ? 'mono' : 'dark'))
            }
          >
            {theme === 'light' ? <Ic.sun size={13} /> : <Ic.moon size={13} />}
          </button>
          {selectedProject && (
            <button className="hbtn danger" title="Delete project" onClick={handleDeleteProject}>
              <Ic.x size={12} />
            </button>
          )}
        </div>
      </header>

      <Sidebar
        projects={projects}
        agents={agents}
        selectedProjectId={selectedProjectId}
        selectedAgentId={selectedAgentId}
        onSelectProject={handleSelectProject}
        onSelectAgent={handleSelectAgent}
        onNewProject={() => setShowNewProject(true)}
        onNewAgent={() => setShowNewAgent(true)}
        onDeleteAgent={handleDeleteAgent}
        onStartAll={handleStartAll}
        onStopAll={handleStopAll}
        onExpandProject={loadAgents}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />
      <div className="sb-resizer" onMouseDown={onSidebarResizeDown} title="Drag to resize sidebar" />

      <section className="gr">
        {selectedProjectId ? (
          <>
            <div className="gr-subbar">
              <div className="gr-tabs">
                <button
                  className={'gr-tab' + (mainTab === 'terminals' ? ' active' : '')}
                  onClick={() => setMainTab('terminals')}
                >
                  <Ic.terminal size={12} /> Terminals
                  <span className="count">{projectAgents.length}</span>
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'messages' ? ' active' : '')}
                  onClick={() => setMainTab('messages')}
                >
                  <Ic.message size={12} /> Messages
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'shared' ? ' active' : '')}
                  onClick={() => setMainTab('shared')}
                >
                  <Ic.folder size={12} /> Shared
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'wiki' ? ' active' : '')}
                  onClick={() => setMainTab('wiki')}
                >
                  <Ic.book size={12} /> Wiki
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'activity' ? ' active' : '')}
                  onClick={() => setMainTab('activity')}
                >
                  <Ic.activity size={12} /> Activity
                </button>
              </div>
              <div className="gr-subbar-r">
                {mainTab === 'terminals' && projectAgents.length > 0 && (
                  <>
                    <button
                      className="batch-btn"
                      onClick={() => handleStartAll()}
                      disabled={stoppedCount === 0}
                    >
                      <Ic.play size={10} /> Start all
                    </button>
                    <button
                      className="batch-btn"
                      onClick={() => handleStopAll()}
                      disabled={runningCount === 0}
                    >
                      <Ic.stop size={9} /> Stop all
                    </button>
                  </>
                )}
                <button className="batch-btn primary" onClick={() => setShowNewAgent(true)}>
                  <Ic.plus size={11} /> New agent
                </button>
              </div>
            </div>

            {mainTab === 'terminals' && (
              <AgentGrid
                agents={projectAgents}
                layout={layout}
                focusedId={selectedAgentId}
                onFocus={setSelectedAgentId}
                onStart={handleStartAgent}
                onStop={handleStopAgent}
                onRestart={handleRestartAgent}
                onDelete={handleDeleteAgent}
                send={send}
                wsRef={wsRef}
                projectId={selectedProjectId}
              />
            )}
            {mainTab === 'messages' && (
              <MessagesPanel projectId={selectedProjectId} agents={projectAgents} wsRef={wsRef} />
            )}
            {mainTab === 'shared' && (
              <SharedContentView projectId={selectedProjectId} refreshTrigger={contentRefresh} />
            )}
            {mainTab === 'wiki' && <ProjectWiki projectId={selectedProjectId} />}
            {mainTab === 'activity' && <ActivityFeed projectId={selectedProjectId} wsRef={wsRef} />}
          </>
        ) : (
          <div className="panel-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <div>Select or create a project to get started</div>
            <button className="batch-btn primary" onClick={() => setShowNewProject(true)}>
              <Ic.plus size={11} /> New Project
            </button>
          </div>
        )}
      </section>

      <footer className="st">
        <div className="st-l">
          {selectedProjectId && (
            <>
              <span className="st-item">
                <span className="sdot running" style={{ width: 6, height: 6 }} /> {runningCount} running
              </span>
              <span className="st-item" style={{ color: 'var(--text-2)' }}>
                <span className="sdot stopped" style={{ width: 6, height: 6 }} /> {stoppedCount} stopped
              </span>
            </>
          )}
        </div>
        <div className="st-r">
          <span className="st-kbd"><kbd>{MOD}K</kbd> palette</span>
          <span className="st-kbd"><kbd>{MOD}1-5</kbd> agent</span>
          <span className="st-item ok">ws · connected</span>
        </div>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={projectAgents}
        onSelectAgent={setSelectedAgentId}
        onLayout={setLayout}
        onTheme={setTheme}
        onNewProject={() => setShowNewProject(true)}
        onNewAgent={() => setShowNewAgent(true)}
        onStartAll={selectedProjectId ? () => handleStartAll() : undefined}
        onStopAll={selectedProjectId ? () => handleStopAll() : undefined}
      />

      {showNewProject && (
        <CreateProjectModal
          onClose={() => setShowNewProject(false)}
          onCreate={handleCreateProject}
        />
      )}
      {showNewAgent && selectedProject && (
        <CreateAgentModal
          projectCwd={selectedProject.cwd}
          onClose={() => setShowNewAgent(false)}
          onCreate={handleCreateAgent}
        />
      )}
    </div>
  );
}
