import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Terminal from './components/Terminal';
import SplitLayout, { type SplitNode, createPane } from './components/SplitLayout';
import SharedContentView from './components/SharedContent';
import ActivityFeed from './components/ActivityFeed';
import CreateProjectModal from './components/CreateProjectModal';
import CreateAgentModal from './components/CreateAgentModal';
import { useWebSocket } from './hooks/useWebSocket';
import * as api from './api';
import type { Project, Agent } from './api';

type MainTab = 'terminals' | 'content' | 'activity';
type ViewMode = 'single' | 'split';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent[]>>(new Map());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('terminals');
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [splitTrees, setSplitTrees] = useState<Map<string, SplitNode>>(new Map());
  const [contentRefresh, setContentRefresh] = useState(0);

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
        <h1>Termhive</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {selectedProject && (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {selectedProject.name}
            </span>
          )}
          {selectedProjectId && mainTab === 'terminals' && (
            <div className="layout-switcher">
              <button
                onClick={() => setViewMode('single')}
                title="Single View"
                style={{
                  padding: '3px 8px',
                  fontSize: 12,
                  background: viewMode === 'single' ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: viewMode === 'single' ? '#000' : 'var(--text-primary)',
                  border: viewMode === 'single' ? '1px solid var(--accent)' : '1px solid var(--border)',
                }}
              >
                Single
              </button>
              <button
                onClick={() => setViewMode('split')}
                title="Split View (tmux-like)"
                style={{
                  padding: '3px 8px',
                  fontSize: 12,
                  background: viewMode === 'split' ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: viewMode === 'split' ? '#000' : 'var(--text-primary)',
                  border: viewMode === 'split' ? '1px solid var(--accent)' : '1px solid var(--border)',
                }}
              >
                Split
              </button>
            </div>
          )}
          {selectedProject && (
            <button className="danger" onClick={handleDeleteProject} style={{ fontSize: 11 }}>
              Delete Project
            </button>
          )}
        </div>
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
