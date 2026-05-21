import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import AgentGrid, { type GridLayout } from './components/AgentGrid';
import SharedContentView from './components/SharedContent';
import ActivityFeed from './components/ActivityFeed';
import ProjectWiki from './components/ProjectWiki';
import MessagesPanel from './components/MessagesPanel';
import CommandPalette from './components/CommandPalette';
import CommandPanel from './components/CommandPanel';
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
  const [commandOpen, setCommandOpen] = useState(false);
  // Orchestrator-brain completion cue — shown when the brain finishes a task
  // while the Command panel is closed.
  const [brainDone, setBrainDone] = useState(false);
  const [brainToast, setBrainToast] = useState(false);
  const [brainWorking, setBrainWorking] = useState(false);
  const [quickCmd, setQuickCmd] = useState('');
  const commandOpenRef = useRef(commandOpen);
  commandOpenRef.current = commandOpen;
  const brainBusyRef = useRef(false);
  const brainToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (msg.type === 'org:changed') {
      // The orchestrator created/changed a project or agent — refresh the sidebar.
      loadProjects();
      if (selectedProjectId) loadAgents(selectedProjectId);
    }
    if (msg.type === 'brain:event') {
      // Detect the orchestrator finishing a task (thinking → idle).
      const p = (msg as { payload?: { kind?: string; status?: string } }).payload;
      if (p?.kind === 'status') {
        if (p.status === 'thinking') {
          brainBusyRef.current = true;
          setBrainWorking(true);
        } else if (p.status === 'idle' && brainBusyRef.current) {
          brainBusyRef.current = false;
          setBrainWorking(false);
          if (!commandOpenRef.current) {
            setBrainDone(true);
            setBrainToast(true);
            if (brainToastTimer.current) clearTimeout(brainToastTimer.current);
            brainToastTimer.current = setTimeout(() => setBrainToast(false), 8000);
          }
        }
      }
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

  // Opening the Command panel clears the brain-completion cue.
  useEffect(() => {
    if (commandOpen) { setBrainDone(false); setBrainToast(false); }
  }, [commandOpen]);

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
  const awaitingCount = projectAgents.filter((a) => a.status === 'awaiting_input').length;
  const idleCount = projectAgents.filter((a) => a.status === 'idle').length;
  const stoppedCount = projectAgents.filter((a) => a.status === 'stopped').length;
  // "alive" = process exists (running / awaiting / idle) — used for Stop-all gating
  const aliveCount = runningCount + awaitingCount + idleCount;

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
      if (mod && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault(); e.stopPropagation();
        setCommandOpen((o) => !o); return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const i = parseInt(e.key, 10) - 1;
        const a = projectAgents[i];
        if (a) setSelectedAgentId(a.id);
        return;
      }
      if (e.key === 'Escape') { setPaletteOpen(false); setCommandOpen(false); }
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
    // Stop everything that is alive — running, awaiting_input, or idle
    const alive = list.filter((a) => a.status !== 'stopped');
    await Promise.all(alive.map((a) => api.stopAgent(pid, a.id)));
    await loadAgents(pid);
  };

  // Fire a one-off command at the orchestrator brain straight from the header,
  // without opening the Command drawer.
  const fireQuickCmd = () => {
    const text = quickCmd.trim();
    if (!text || brainWorking) return;
    send({ type: 'brain:send', message: text });
    setQuickCmd('');
    brainBusyRef.current = true;
    setBrainWorking(true);
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
          <div className={'cmd-quick' + (brainWorking ? ' working' : '')}>
            <button
              className="cmd-quick-mark"
              title="Open Command (⌘J)"
              onClick={() => setCommandOpen(true)}
            >
              <Ic.logo size={13} />
              {brainDone && <span className="cmd-trigger-dot" />}
            </button>
            <input
              className="cmd-quick-input"
              value={quickCmd}
              onChange={(e) => setQuickCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); fireQuickCmd(); }
              }}
              placeholder={brainWorking ? 'The Keeper is working…' : 'Ask The Keeper…'}
              disabled={brainWorking}
            />
            <kbd>{MOD}J</kbd>
          </div>
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
                      disabled={aliveCount === 0}
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
              {awaitingCount > 0 && (
                <span className="st-item" style={{ color: 'var(--attn)' }}>
                  <span className="sdot awaiting_input" style={{ width: 6, height: 6 }} /> {awaitingCount} awaiting you
                </span>
              )}
              {idleCount > 0 && (
                <span className="st-item" style={{ color: 'var(--text-2)' }}>
                  <span className="sdot idle" style={{ width: 6, height: 6 }} /> {idleCount} idle
                </span>
              )}
              <span className="st-item" style={{ color: 'var(--text-2)' }}>
                <span className="sdot stopped" style={{ width: 6, height: 6 }} /> {stoppedCount} stopped
              </span>
            </>
          )}
        </div>
        <div className="st-r">
          <span className="st-kbd"><kbd>{MOD}K</kbd> palette</span>
          <span className="st-kbd"><kbd>{MOD}J</kbd> command</span>
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

      <CommandPanel
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        wsRef={wsRef}
      />

      {!commandOpen && brainWorking && (
        <button className="brain-toast working" onClick={() => setCommandOpen(true)}>
          <span className="brain-toast-dots">
            <span className="cmd-dot" /><span className="cmd-dot" /><span className="cmd-dot" />
          </span>
          <span className="brain-toast-txt">
            <strong>The Keeper is working…</strong>
            <span>Tap to watch</span>
          </span>
        </button>
      )}
      {!commandOpen && !brainWorking && brainToast && (
        <button
          className="brain-toast"
          onClick={() => { setCommandOpen(true); setBrainToast(false); }}
        >
          <span className="brain-toast-mark"><Ic.logo size={14} /></span>
          <span className="brain-toast-txt">
            <strong>The Keeper finished</strong>
            <span>Tap to see the result</span>
          </span>
        </button>
      )}

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
