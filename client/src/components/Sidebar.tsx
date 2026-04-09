import { useState } from 'react';
import type { Project, Agent } from '../api';

interface Props {
  projects: Project[];
  agents: Map<string, Agent[]>;
  selectedProjectId: string | null;
  selectedAgentId: string | null;
  onSelectProject: (id: string) => void;
  onSelectAgent: (projectId: string, agentId: string) => void;
  onNewProject: () => void;
  onNewAgent: () => void;
  onDeleteAgent: (agent: Agent) => void;
  onStartAll: (projectId: string) => void;
  onStopAll: (projectId: string) => void;
  onExpandProject: (projectId: string) => void;
}

export default function Sidebar({
  projects, agents, selectedProjectId, selectedAgentId,
  onSelectProject, onSelectAgent, onNewProject, onNewAgent,
  onDeleteAgent, onStartAll, onStopAll, onExpandProject,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  const toggleProject = (id: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        onExpandProject(id);
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <div
        className="sidebar sidebar-collapsed"
        onClick={() => setCollapsed(false)}
        title="Expand sidebar"
      >
        <div className="sidebar-collapsed-label">PROJECTS</div>
        <div className="sidebar-collapsed-arrow">&#x25B6;</div>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-left">
          <span
            onClick={() => setCollapsed(true)}
            className="sidebar-collapse-btn"
            title="Collapse sidebar"
          >&#x25C0;</span>
          <span className="sidebar-header-title">Projects</span>
        </div>
        <button className="btn-sm btn-primary" onClick={onNewProject}>+ New</button>
      </div>

      <div className="sidebar-list">
        {projects.map(project => {
          const projectAgents = agents.get(project.id) || [];
          const isSelected = selectedProjectId === project.id;
          const isExpanded = expandedProjects.has(project.id);
          const runningCount = projectAgents.filter(a => a.status === 'running').length;

          return (
            <div key={project.id} className="sidebar-project">
              <div
                className={`sidebar-project-item ${isSelected ? 'active' : ''}`}
                onClick={() => onSelectProject(project.id)}
              >
                <span
                  onClick={(e) => { e.stopPropagation(); toggleProject(project.id); }}
                  className="sidebar-expand-btn"
                >
                  {isExpanded ? '−' : '+'}
                </span>
                <div className="sidebar-project-info">
                  <span className="sidebar-project-name">{project.name}</span>
                  {projectAgents.length > 0 && (
                    <span className="sidebar-project-stats">
                      {runningCount > 0 && <span className="stats-running">{runningCount} running</span>}
                      {runningCount === 0 && <span className="stats-total">{projectAgents.length} agents</span>}
                    </span>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="sidebar-agents">
                  {projectAgents.length > 0 && (
                    <div className="sidebar-agent-actions">
                      <button
                        onClick={(e) => { e.stopPropagation(); onStartAll(project.id); }}
                        className="btn-xs btn-primary"
                      >
                        Start All
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onStopAll(project.id); }}
                        className="btn-xs btn-danger"
                      >
                        Stop All
                      </button>
                    </div>
                  )}

                  {projectAgents.map(agent => (
                    <div
                      key={agent.id}
                      className={`sidebar-agent-item ${selectedAgentId === agent.id ? 'active' : ''}`}
                      onClick={() => onSelectAgent(project.id, agent.id)}
                    >
                      <div className="sidebar-agent-header">
                        <span className={`status-dot ${agent.status}`} />
                        <span className="sidebar-agent-name">{agent.name}</span>
                        <span className="sidebar-agent-cli">{agent.cli}</span>
                        <span
                          className="sidebar-agent-delete"
                          onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent); }}
                          title="Delete agent"
                        >
                          &times;
                        </span>
                      </div>
                    </div>
                  ))}

                  <div
                    className="sidebar-agent-add"
                    onClick={() => { onSelectProject(project.id); onNewAgent(); }}
                  >
                    + Add Agent
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {projects.length === 0 && (
          <div className="sidebar-empty">
            No projects yet
          </div>
        )}
      </div>
    </div>
  );
}
