import { useState, useEffect } from 'react';
import * as api from '../api';

interface Props {
  projectId: string;
}

// Simple markdown to HTML
function renderMarkdown(md: string): string {
  let html = md
    .replace(/```[\s\S]*?```/g, (m) => {
      const code = m.slice(3, -3).replace(/^\w*\n/, '');
      return '<pre><code>' + escapeHtml(code) + '</code></pre>';
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^\|(.+)\|$/gm, (_, row) => {
      const cells = row.split('|').map((c: string) => c.trim());
      return '<tr>' + cells.map((c: string) => '<td>' + c + '</td>').join('') + '</tr>';
    })
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  html = html.replace(/(<li>.*?<\/li>)(\s*<br\/>)*/g, '$1');
  html = html.replace(/((?:<li>.*?<\/li>)+)/g, '<ul>$1</ul>');
  html = html.replace(/((?:<tr>.*?<\/tr>\s*)+)/g, '<table>$1</table>');
  html = html.replace(/<\/blockquote>\s*<br\/?>\s*<blockquote>/g, '<br/>');

  return '<p>' + html + '</p>';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// Parse _log.md into entries
function parseLog(content: string): { date: string; action: string; summary: string }[] {
  const entries: { date: string; action: string; summary: string }[] = [];
  const regex = /^## \[(\d{4}-\d{2}-\d{2})\]\s*(\w+)\s*\|\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ date: match[1], action: match[2], summary: match[3] });
  }
  return entries.reverse(); // newest first
}

export default function ProjectMemory({ projectId }: Props) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [files, setFiles] = useState<api.SharedContent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logEntries, setLogEntries] = useState<{ date: string; action: string; summary: string }[]>([]);

  useEffect(() => {
    setInitialized(null);
    setFiles([]);
    setSelected(null);
    setContent('');
    setEditing(false);
    setLogEntries([]);
    api.getMemoryStatus(projectId).then(s => {
      setInitialized(s.initialized);
      if (s.initialized) loadFiles();
    });
  }, [projectId]);

  const loadFiles = async () => {
    const list = await api.listMemoryFiles(projectId);
    setFiles(list);
    if (list.length > 0 && !selected) {
      const def = list.find(f => f.filename === '_index.md') || list.find(f => f.filename === 'overview.md') || list[0];
      setSelected(def.filename);
    }
    // Load log entries
    try {
      const log = await api.getMemoryFile(projectId, '_log.md');
      if (log) setLogEntries(parseLog(log.content));
    } catch { /* no log yet */ }
  };

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    setEditing(false);
    api.getMemoryFile(projectId, selected).then(item => {
      if (item) setContent(item.content);
    }).catch(() => setContent(''));
  }, [projectId, selected]);

  const handleInit = async () => {
    await api.initializeMemory(projectId);
    setInitialized(true);
    await loadFiles();
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    await api.updateMemoryFile(projectId, selected, content);
    setSaving(false);
    setEditing(false);
    // Reload log if we edited it
    if (selected === '_log.md') {
      setLogEntries(parseLog(content));
    }
  };

  if (initialized === null) {
    return <div className="empty-state">Loading...</div>;
  }

  if (!initialized) {
    return (
      <div className="empty-state">
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>&#x1f9e0;</div>
          <h3 style={{ marginBottom: 8 }}>Project Memory</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
            Initialize a persistent knowledge base for this project.
            AI agents will maintain architecture docs, API specs, decisions,
            and progress — following Karpathy's LLM Wiki pattern.
          </p>
          <button className="primary" onClick={handleInit} style={{ padding: '6px 20px', fontSize: 13 }}>
            Initialize Memory
          </button>
        </div>
      </div>
    );
  }

  const coreFiles = files.filter(f => !f.filename.startsWith('_') && !f.filename.includes('/'));
  const metaFiles = files.filter(f => f.filename.startsWith('_'));
  const agentFiles = files.filter(f => f.filename.startsWith('agents/'));
  const rawFiles = files.filter(f => f.filename.startsWith('raw/'));

  const FileItem = ({ f }: { f: api.SharedContent }) => (
    <div
      className={`memory-file-item ${selected === f.filename ? 'active' : ''}`}
      onClick={() => setSelected(f.filename)}
    >
      <span style={{ flex: 1 }}>
        {f.filename.startsWith('_') ? f.filename : f.filename.replace(/^(agents|raw)\//, '')}
      </span>
      {f.updatedAt && (
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
          {timeAgo(f.updatedAt)}
        </span>
      )}
    </div>
  );

  const goToIndex = () => setSelected('_index.md');

  return (
    <div className="memory-container">
      <div className="memory-sidebar">
        <div className="memory-section-title">Index</div>
        {metaFiles.map(f => <FileItem key={f.filename} f={f} />)}

        <div className="memory-section-title">Core</div>
        {coreFiles.map(f => <FileItem key={f.filename} f={f} />)}

        {agentFiles.length > 0 && (
          <>
            <div className="memory-section-title">Agents</div>
            {agentFiles.map(f => <FileItem key={f.filename} f={f} />)}
          </>
        )}

        {rawFiles.length > 0 && (
          <>
            <div className="memory-section-title">Raw</div>
            {rawFiles.map(f => <FileItem key={f.filename} f={f} />)}
          </>
        )}

        {/* Log timeline in sidebar */}
        {logEntries.length > 0 && (
          <>
            <div className="memory-section-title" style={{ marginTop: 12 }}>Recent Activity</div>
            <div className="memory-log-timeline">
              {logEntries.slice(0, 10).map((entry, i) => (
                <div key={i} className="memory-log-entry">
                  <span className="memory-log-date">{entry.date}</span>
                  <span className="memory-log-summary">{entry.summary}</span>
                </div>
              ))}
              {logEntries.length > 10 && (
                <div
                  className="memory-file-item"
                  onClick={() => setSelected('_log.md')}
                  style={{ fontSize: 11, opacity: 0.6, textAlign: 'center' }}
                >
                  View all ({logEntries.length})
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="memory-content">
        {selected ? (
          <>
            <div className="memory-content-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {selected !== '_index.md' && (
                  <span
                    onClick={goToIndex}
                    style={{ cursor: 'pointer', fontSize: 14, color: 'var(--accent)' }}
                    title="Back to Index"
                  >
                    &larr;
                  </span>
                )}
                <span style={{ fontWeight: 600 }}>{selected}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {editing ? (
                  <>
                    <button onClick={handleSave} className="primary" disabled={saving}>
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={() => {
                      setEditing(false);
                      api.getMemoryFile(projectId, selected).then(item => {
                        if (item) setContent(item.content);
                      });
                    }}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setEditing(true)}>Edit</button>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                className="memory-editor"
                value={content}
                onChange={e => setContent(e.target.value)}
                onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); } }}
              />
            ) : (
              <div
                className="memory-rendered"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.tagName === 'A') {
                    e.preventDefault();
                    const href = target.getAttribute('href') || '';
                    if (href.endsWith('.md') && !href.startsWith('http')) {
                      const currentDir = selected?.includes('/') ? selected.split('/').slice(0, -1).join('/') : '';
                      const resolved = currentDir && !href.startsWith('/') ? currentDir + '/' + href : href;
                      const found = files.find(f => f.filename === resolved) || files.find(f => f.filename === href);
                      if (found) setSelected(found.filename);
                    }
                  }
                }}
              />
            )}
          </>
        ) : (
          <div className="empty-state">Select a page</div>
        )}
      </div>
    </div>
  );
}
