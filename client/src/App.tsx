import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Terminal from './components/Terminal';
import SplitLayout, { type SplitNode, createPane } from './components/SplitLayout';
import SharedContentView from './components/SharedContent';
import ActivityFeed from './components/ActivityFeed';
import ProjectMemory from './components/ProjectMemory';
import CreateProjectModal from './components/CreateProjectModal';
import CreateAgentModal from './components/CreateAgentModal';
import { useWebSocket } from './hooks/useWebSocket';
import logoIcon from './assets/logo.svg';
import * as api from './api';
import type { Project, Agent } from './api';

type MainTab = 'terminals' | 'content' | 'memory' | 'activity';
type ViewMode = 'single' | 'split';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent[]>>(new Map());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('terminals');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('termhive:theme') as 'dark' | 'light') || 'dark';
  });
  const [showThemeHint, setShowThemeHint] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('termhive:theme', theme);
  }, [theme]);

  const handleThemeToggle = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    if (newTheme === 'light') {
      setShowThemeHint(true);
      setTimeout(() => setShowThemeHint(false), 8000);
    } else {
      setShowThemeHint(false);
    }
  };
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('termhive:viewMode') as ViewMode) || 'single';
  });
  const [splitTrees, setSplitTrees] = useState<Map<string, SplitNode>>(() => {
    try {
      const saved = localStorage.getItem('termhive:splitTrees');
      if (saved) {
        const obj = JSON.parse(saved);
        return new Map(Object.entries(obj));
      }
    } catch { /* ignore */ }
    return new Map();
  });
  const [contentRefresh, setContentRefresh] = useState(0);

  // Persist split layouts and view mode to localStorage
  useEffect(() => {
    localStorage.setItem('termhive:viewMode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    const obj: Record<string, SplitNode> = {};
    for (const [k, v] of splitTrees) { obj[k] = v; }
    localStorage.setItem('termhive:splitTrees', JSON.stringify(obj));
  }, [splitTrees]);

  const { send, wsRef } = useWebSocket((msg) => {
    // Auto-refresh shared content when files change
    if (msg.type === 'content:updated') {
      setContentRefresh(prev => prev + 1);
    }
    if (msg.type === 'agent:status' && msg.agentId && msg.status) {
      setAgents(prev => {
        const next = new Map(prev);
        for (const [pid, list] of next) {
          const updated = list.map(a =>
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
    setAgents(prev => new Map(prev).set(projectId, list));
  }, []);

  useEffect(() => { loadProjects(); }, []);

  useEffect(() => {
    if (selectedProjectId) loadAgents(selectedProjectId);
  }, [selectedProjectId]);

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

  const handleDeleteAgent = async (agent: Agent) => {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    await api.deleteAgent(agent.projectId, agent.id);
    if (selectedAgentId === agent.id) setSelectedAgentId(null);
    await loadAgents(agent.projectId);
  };

  const handleDeleteProject = async () => {
    if (!selectedProjectId) return;
    const project = projects.find(p => p.id === selectedProjectId);
    if (!confirm(`Delete project "${project?.name}"?`)) return;
    await api.deleteProject(selectedProjectId);
    setSelectedProjectId(null);
    setSelectedAgentId(null);
    await loadProjects();
  };

  const handleStartAll = async (projectId: string) => {
    const projectAgents = agents.get(projectId) || [];
    const stopped = projectAgents.filter(a => a.status === 'stopped');
    await Promise.all(stopped.map(a => api.startAgent(projectId, a.id)));
    await loadAgents(projectId);
  };

  const handleStopAll = async (projectId: string) => {
    const projectAgents = agents.get(projectId) || [];
    const running = projectAgents.filter(a => a.status === 'running');
    await Promise.all(running.map(a => api.stopAgent(projectId, a.id)));
    await loadAgents(projectId);
  };

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const projectAgents = selectedProjectId ? agents.get(selectedProjectId) || [] : [];
  const selectedAgent = projectAgents.find(a => a.id === selectedAgentId);

  const splitTree = selectedProjectId ? (splitTrees.get(selectedProjectId) || createPane()) : createPane();
  const setSplitTree = (tree: SplitNode) => {
    if (!selectedProjectId) return;
    setSplitTrees(prev => new Map(prev).set(selectedProjectId, tree));
  };

  return (
    <div className="app">
      <div className="header">
        <h1>
          <div className="header-breadcrumb">
            <div className="header-logo">
              <img src={logoIcon} alt="Termhive" />
            </div>
            <span>Termhive</span>
            {selectedProject && (
              <>
                <span className="header-separator">/</span>
                <span className="header-project-name">{selectedProject.name}</span>
              </>
            )}
          </div>
        </h1>
        <div className="header-right">
          {selectedProjectId && mainTab === 'terminals' && (
            <div className="segmented-toggle">
              <button
                onClick={() => setViewMode('single')}
                className={viewMode === 'single' ? 'active' : ''}
              >
                Single
              </button>
              <div className="segmented-toggle-divider" />
              <button
                onClick={() => setViewMode('split')}
                className={viewMode === 'split' ? 'active' : ''}
              >
                Split
              </button>
            </div>
          )}
          {selectedProject && (
            <button className="danger" onClick={handleDeleteProject}>
              Delete Project
            </button>
          )}
          <button
            onClick={handleThemeToggle}
            className="theme-toggle"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 1.5V2.5M7 11.5V12.5M1.5 7H2.5M11.5 7H12.5M3.1 3.1L3.8 3.8M10.2 10.2L10.9 10.9M3.1 10.9L3.8 10.2M10.2 3.8L10.9 3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M12 8.5A5.5 5.5 0 115.5 2 4 4 0 0012 8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </div>
        {showThemeHint && (
          <div className="theme-hint">
            <span>For best results, type <code>/theme</code> in Claude Code and select <strong>Light mode</strong></span>
            <button onClick={() => setShowThemeHint(false)} className="theme-hint-close">&times;</button>
          </div>
        )}
      </div>

      <div className="main">
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
        />

        <div className="content">
          {selectedProjectId ? (
            <>
              <div className="tabs">
                <div
                  className={`tab ${mainTab === 'terminals' ? 'active' : ''}`}
                  onClick={() => setMainTab('terminals')}
                >
                  Terminals
                </div>
                <div
                  className={`tab ${mainTab === 'content' ? 'active' : ''}`}
                  onClick={() => setMainTab('content')}
                >
                  Shared Content
                </div>
                <div
                  className={`tab ${mainTab === 'memory' ? 'active' : ''}`}
                  onClick={() => setMainTab('memory')}
                >
                  Memory
                </div>
                <div
                  className={`tab ${mainTab === 'activity' ? 'active' : ''}`}
                  onClick={() => setMainTab('activity')}
                >
                  Activity
                </div>
              </div>

              <div className="tab-content">
                {mainTab === 'terminals' ? (
                  viewMode === 'single' ? (
                    // Single mode — click sidebar to switch agent
                    selectedAgent ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div className="split-pane-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className={`status-dot ${selectedAgent.status}`} />
                            <strong>{selectedAgent.name}</strong>
                            <span style={{ fontSize: 11, opacity: 0.6 }}>
                              {selectedAgent.cli} &middot; {selectedAgent.cwd}
                            </span>
                            {selectedAgent.flags?.dangerouslySkipPermissions && (
                              <span style={{ fontSize: 10, color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '0 4px' }}>skip-perms</span>
                            )}
                            {selectedAgent.flags?.remoteControl && (
                              <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 3, padding: '0 4px' }}>remote</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {selectedAgent.status === 'stopped' ? (
                              <button className="primary" onClick={() => handleStartAgent(selectedAgent)}>Start</button>
                            ) : (
                              <button onClick={() => handleStopAgent(selectedAgent)}>Stop</button>
                            )}
                          </div>
                        </div>
                        {selectedAgent.status === 'running' ? (
                          <Terminal agentId={selectedAgent.id} send={send} wsRef={wsRef} />
                        ) : (
                          <div className="empty-state">
                            <span>Agent is stopped</span>
                            <button className="primary" onClick={() => handleStartAgent(selectedAgent)}>Start Agent</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="empty-state">
                        {projectAgents.length > 0
                          ? 'Select an agent from the sidebar'
                          : 'No agents yet. Add one from the sidebar.'}
                      </div>
                    )
                  ) : (
                    // Split mode — tmux-like
                    projectAgents.length > 0 ? (
                      <SplitLayout
                        agents={projectAgents}
                        send={send}
                        wsRef={wsRef}
                        tree={splitTree}
                        onTreeChange={setSplitTree}
                        onStartAgent={handleStartAgent}
                        onStopAgent={handleStopAgent}
                      />
                    ) : (
                      <div className="empty-state">
                        No agents yet. Add one from the sidebar.
                      </div>
                    )
                  )
                ) : mainTab === 'content' ? (
                  <SharedContentView projectId={selectedProjectId} refreshTrigger={contentRefresh} />
                ) : mainTab === 'memory' ? (
                  <ProjectMemory projectId={selectedProjectId} />
                ) : (
                  <ActivityFeed projectId={selectedProjectId} wsRef={wsRef} />
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <span>Select or create a project to get started</span>
              <button className="primary" onClick={() => setShowNewProject(true)}>
                New Project
              </button>
            </div>
          )}
        </div>
      </div>

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
