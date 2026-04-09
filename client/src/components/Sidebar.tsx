import { useState, useEffect } from 'react';
import type { Project, Agent } from '../api';
import claudeIcon from '../assets/claude.svg';
import codexIcon from '../assets/codex.svg';

const cliIcons: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
};

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

function UsageBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <>
      <div className="sidebar-usage-row">
        <span className="sidebar-usage-label">{label}</span>
        <span className="sidebar-usage-pct">{Math.round(value)}%</span>
      </div>
      <div className="sidebar-usage-bar">
        <div className="sidebar-usage-fill" style={{ width: value + '%', background: color }} />
      </div>
    </>
  );
}

export default function Sidebar({
  projects, agents, selectedProjectId, selectedAgentId,
  onSelectProject, onSelectAgent, onNewProject, onNewAgent,
  onDeleteAgent, onStartAll, onStopAll, onExpandProject,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [usageData, setUsageData] = useState<{
    claude: { session: number | null; week: number | null } | null;
    codex: { session: number | null; week: number | null } | null;
  }>({ claude: null, codex: null });

  useEffect(() => {
    const fetchUsage = () => {
      fetch('/api/usage').then(r => r.json()).then(data => {
        setUsageData({
          claude: data.claude ? { session: data.claude.session?.utilization ?? null, week: data.claude.week?.utilization ?? null } : null,
          codex: data.codex ? { session: data.codex.session?.utilization ?? null, week: data.codex.week?.utilization ?? null } : null,
        });
      }).catch(() => {});
    };
    fetchUsage();
    const interval = setInterval(fetchUsage, 60000);
    return () => clearInterval(interval);
  }, []);

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
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    <path d="M5.25 3.5L8.75 7L5.25 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <div className="sidebar-project-info">
                  <span className="sidebar-project-name">{project.name}</span>
                  {projectAgents.length > 0 && (
                    <span className="sidebar-project-stats">
                      <span className={runningCount > 0 ? 'stats-running' : 'stats-total'}>{projectAgents.length}</span>
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
                        className="btn-xs btn-start-all"
                      >
                        Start All
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onStopAll(project.id); }}
                        className="btn-xs btn-stop-all"
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

      {(usageData.claude || usageData.codex) && (
        <div className="sidebar-usage">
          {usageData.claude && (
            <>
              <div className="sidebar-usage-title">
                <div className="sidebar-usage-icon-wrapper claude">
                  <img src={claudeIcon} alt="Claude" className="sidebar-usage-icon" />
                </div>
                Claude
              </div>
              {usageData.claude.session !== null && (
                <UsageBar label="Session" value={usageData.claude.session} color="var(--accent)" />
              )}
              {usageData.claude.week !== null && (
                <UsageBar label="Week" value={usageData.claude.week} color="var(--accent)" />
              )}
            </>
          )}
          {usageData.codex && (
            <>
              <div className="sidebar-usage-title" style={usageData.claude ? { marginTop: 14 } : undefined}>
                <div className="sidebar-usage-icon-wrapper codex">
                  <img src={codexIcon} alt="Codex" className="sidebar-usage-icon" />
                </div>
                Codex
              </div>
              {usageData.codex.session !== null && (
                <UsageBar label="Session" value={usageData.codex.session} color="var(--yellow)" />
              )}
              {usageData.codex.week !== null && (
                <UsageBar label="Week" value={usageData.codex.week} color="var(--yellow)" />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
