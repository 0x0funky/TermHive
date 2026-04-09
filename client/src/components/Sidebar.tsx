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
        className="sidebar"
        style={{ width: 40, minWidth: 40, alignItems: 'center', cursor: 'pointer' }}
        onClick={() => setCollapsed(false)}
        title="Expand sidebar"
      >
        <div style={{ padding: '12px 0', writingMode: 'vertical-rl', fontSize: 12, color: 'var(--text-secondary)', letterSpacing: 2 }}>
          PROJECTS
        </div>
        <div style={{ fontSize: 16, marginTop: 8 }}>&#x25B6;</div>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              onClick={() => setCollapsed(true)}
              style={{ cursor: 'pointer', fontSize: 12 }}
              title="Collapse sidebar"
            >&#x25C0;</span>
            Projects
          </div>
          <button onClick={onNewProject}>+ New</button>
        </div>
        {projects.map(project => {
          const projectAgents = agents.get(project.id) || [];
          const isSelected = selectedProjectId === project.id;
          const isExpanded = expandedProjects.has(project.id);

          return (
            <div key={project.id}>
              <div
                className={`project-item ${isSelected ? 'active' : ''}`}
                onClick={() => onSelectProject(project.id)}
              >
                <span
                  onClick={(e) => { e.stopPropagation(); toggleProject(project.id); }}
                  style={{ cursor: 'pointer', fontSize: 10, width: 14, textAlign: 'center', flexShrink: 0 }}
                >
                  {isExpanded ? '−' : '+'}
                </span>
                <span style={{ flex: 1 }}>{project.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {projectAgents.length > 0 ? `${projectAgents.length}` : ''}
                </span>
              </div>
              {isExpanded && (
                <>
                  {projectAgents.length > 0 && (
                    <div style={{ padding: '2px 8px 2px 28px', display: 'flex', gap: 4 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); onStartAll(project.id); }}
                        className="primary"
                        style={{ fontSize: 10, padding: '2px 8px', flex: 1 }}
                      >
                        Start All
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onStopAll(project.id); }}
                        className="danger"
                        style={{ fontSize: 10, padding: '2px 8px', flex: 1 }}
                      >
                        Stop All
                      </button>
                    </div>
                  )}
                  {projectAgents.map(agent => (
                    <div
                      key={agent.id}
                      className={`agent-item ${selectedAgentId === agent.id ? 'active' : ''}`}
                      onClick={() => onSelectAgent(project.id, agent.id)}
                    >
                      <span className={`status-dot ${agent.status}`} />
                      <span style={{ flex: 1 }}>{agent.name}</span>
                      <span style={{ fontSize: 10, opacity: 0.5 }}>{agent.cli}</span>
                      <span
                        className="agent-delete-btn"
                        onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent); }}
                        title="Delete agent"
                      >
                        &times;
                      </span>
                    </div>
                  ))}
                  <div className="agent-item" onClick={() => { onSelectProject(project.id); onNewAgent(); }} style={{ opacity: 0.6 }}>
                    + Add Agent
                  </div>
                </>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <div style={{ padding: '12px 8px', fontSize: 13, color: 'var(--text-secondary)' }}>
            No projects yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  );
}
