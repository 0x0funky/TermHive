import { useState, useEffect } from 'react';
import type { Project, Agent } from '../api';
import Ic, { MOD } from './Icons';
import { agentHue } from '../utils/agentIdentity';
import claudeIcon from '../assets/claude.svg';
import codexIcon from '../assets/codex.svg';

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
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const reset = new Date(resetsAt);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return diffMins + 'm';
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return diffHrs + 'h ' + (diffMins % 60) + 'm';
  const diffDays = Math.floor(diffHrs / 24);
  return diffDays + 'd';
}

function UsageRow({
  label, pct, color, resetsAt,
}: { label: string; pct: number | null; color: string; resetsAt?: string | null }) {
  if (pct === null) return null;
  const reset = formatResetTime(resetsAt || null);
  return (
    <>
      <div className="sb-usage-row">
        <span className="sb-usage-label">{label}</span>
        <div className="sb-usage-pct">
          {Math.round(pct)}%
          {reset && <span className="reset">· resets {reset}</span>}
        </div>
      </div>
      <div className="sb-usage-bar">
        <div className="sb-usage-fill" style={{ width: Math.min(100, pct) + '%', background: color }} />
      </div>
    </>
  );
}

function UsageTitle({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="sb-usage-title">
      <img src={icon} alt={label} className="sb-usage-ic" />
      {label}
    </div>
  );
}

export default function Sidebar({
  projects, agents, selectedProjectId, selectedAgentId,
  onSelectProject, onSelectAgent, onNewProject, onNewAgent,
  onDeleteAgent, onExpandProject,
  mobileOpen, onMobileClose,
}: Props) {
  const [usageData, setUsageData] = useState<{
    claude: { session: number | null; sessionResets: string | null; week: number | null; weekResets: string | null } | null;
    codex: { session: number | null; sessionResets: string | null; week: number | null; weekResets: string | null } | null;
  }>({ claude: null, codex: null });

  useEffect(() => {
    const fetchUsage = () => {
      fetch('/api/usage').then(r => r.json()).then(data => {
        setUsageData({
          claude: data.claude ? {
            session: data.claude.session?.utilization ?? null,
            sessionResets: data.claude.session?.resetsAt ?? null,
            week: data.claude.week?.utilization ?? null,
            weekResets: data.claude.week?.resetsAt ?? null,
          } : null,
          codex: data.codex ? {
            session: data.codex.session?.utilization ?? null,
            sessionResets: data.codex.session?.resetsAt ?? null,
            week: data.codex.week?.utilization ?? null,
            weekResets: data.codex.week?.resetsAt ?? null,
          } : null,
        });
      }).catch(() => {});
    };
    fetchUsage();
    const interval = setInterval(fetchUsage, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleSelectProject = (id: string) => {
    onSelectProject(id);
    onExpandProject(id);
  };

  const handleSelectAgent = (projectId: string, agentId: string) => {
    onSelectAgent(projectId, agentId);
    onMobileClose();
  };

  const selProj = projects.find(p => p.id === selectedProjectId);
  const projectAgents = selectedProjectId ? agents.get(selectedProjectId) || [] : [];

  return (
    <>
      {mobileOpen && <div className="sb-scrim" onClick={onMobileClose} />}
      <aside className={`sb ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sb-section-h">
          <span>Projects</span>
          <button className="add" onClick={onNewProject} title="New project"><Ic.plus size={13} /></button>
        </div>
        <div className="sb-projects">
          {projects.map(p => {
            const list = agents.get(p.id) || [];
            const runningCount = list.filter(a => a.status === 'running').length;
            const isActive = p.id === selectedProjectId;
            return (
              <button
                key={p.id}
                className={'sb-project' + (isActive ? ' active' : '')}
                onClick={() => handleSelectProject(p.id)}
              >
                <div className="name-row">
                  <span className="n">{p.name}</span>
                  {runningCount > 0
                    ? <span className="running-chip">{runningCount}/{list.length}</span>
                    : <span className="total-chip">{list.length}</span>}
                </div>
              </button>
            );
          })}
          {projects.length === 0 && (
            <div style={{ padding: '16px 10px', color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>
              No projects yet
            </div>
          )}
        </div>

        <div className="sb-section-h" style={{ marginTop: 4 }}>
          <span>{selProj ? selProj.name + ' · agents' : 'Agents'}</span>
          {selProj && (
            <button className="add" onClick={onNewAgent} title="Add agent"><Ic.plus size={13} /></button>
          )}
        </div>

        <div className="sb-agents-wrap">
          {projectAgents.map((a, i) => {
            const hue = agentHue(a.name);
            const isActive = a.id === selectedAgentId;
            return (
              <button
                key={a.id}
                className={'sb-agent' + (isActive ? ' active' : '')}
                onClick={() => handleSelectAgent(a.projectId, a.id)}
                style={{ '--accent-color': hue } as React.CSSProperties}
              >
                <span className="st"><span className={'sdot ' + a.status} /></span>
                <span className="nm">
                  <span>{a.name}</span>
                  <span className="cli-tag" style={{ color: hue, background: `color-mix(in oklab, ${hue} 14%, transparent)` }}>
                    {a.cli}
                  </span>
                </span>
                <span className="sub">{a.role || a.cwd}</span>
                <span className="meta">
                  {i < 5 && <span className="num">{MOD}{i + 1}</span>}
                  <span
                    className="sb-agent-delete"
                    onClick={(e) => { e.stopPropagation(); onDeleteAgent(a); }}
                    title="Delete agent"
                  >
                    <Ic.x size={11} />
                  </span>
                </span>
              </button>
            );
          })}
          {selProj && projectAgents.length === 0 && (
            <div style={{ padding: '14px 10px', color: 'var(--text-3)', fontSize: 11.5, textAlign: 'center' }}>
              No agents yet
            </div>
          )}
          {!selProj && (
            <div style={{ padding: '14px 10px', color: 'var(--text-3)', fontSize: 11.5, textAlign: 'center' }}>
              Select a project above
            </div>
          )}
        </div>

        {(usageData.claude || usageData.codex) && (
          <div className="sb-usage">
            {usageData.claude && (
              <>
                <UsageTitle icon={claudeIcon} label="Claude" />
                <UsageRow
                  label="Session"
                  pct={usageData.claude.session}
                  color="var(--accent)"
                  resetsAt={usageData.claude.sessionResets}
                />
                <UsageRow
                  label="Week"
                  pct={usageData.claude.week}
                  color="var(--accent)"
                  resetsAt={usageData.claude.weekResets}
                />
              </>
            )}
            {usageData.codex && (
              <div style={usageData.claude ? { marginTop: 10 } : undefined}>
                <UsageTitle icon={codexIcon} label="Codex" />
                <UsageRow
                  label="Session"
                  pct={usageData.codex.session}
                  color="oklch(70% 0.12 300)"
                  resetsAt={usageData.codex.sessionResets}
                />
                <UsageRow
                  label="Week"
                  pct={usageData.codex.week}
                  color="oklch(70% 0.12 300)"
                  resetsAt={usageData.codex.weekResets}
                />
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
