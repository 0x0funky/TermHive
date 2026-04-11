import { useState, useEffect } from 'react';
import * as api from '../api';

interface Props {
  projectId: string;
  refreshTrigger?: number;
}

export default function SharedContentView({ projectId, refreshTrigger }: Props) {
  const [items, setItems] = useState<api.SharedContent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    setSelected(null);
    setItems([]);
    setContent('');
    api.listContent(projectId).then(list => {
      setItems(list);
      if (list.length > 0) setSelected(list[0].filename);
    });
  }, [projectId]);

  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    api.listContent(projectId).then(list => {
      setItems(list);
      if (selected) {
        api.getContent(projectId, selected).then(item => {
          if (item) setContent(item.content);
        }).catch(() => {});
      }
    });
  }, [refreshTrigger]);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    api.getContent(projectId, selected).then(item => {
      if (item) setContent(item.content);
    }).catch(() => setContent(''));
  }, [projectId, selected]);

  const reload = async () => {
    const list = await api.listContent(projectId);
    setItems(list);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    await api.updateContent(projectId, selected, content);
    setSaving(false);
  };

  const handleNew = async () => {
    const filename = prompt('Filename (e.g. notes.md):');
    if (!filename) return;
    await api.createContent(projectId, { filename, content: '' });
    await reload();
    setSelected(filename);
    setContent('');
  };

  const handleDelete = async () => {
    if (!selected || !confirm(`Delete ${selected}?`)) return;
    await api.deleteContent(projectId, selected);
    setSelected(null);
    await reload();
  };

  const handleSelect = (filename: string) => {
    setSelected(filename);
    // On mobile, close sidebar after selection
    if (window.innerWidth <= 768) setSidebarOpen(false);
  };

  return (
    <div className="content-tree-layout">
      {/* Sidebar file tree */}
      <div className={`content-tree-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="content-tree-header">
          <span className="content-tree-title">Files</span>
          <button className="btn-new-project" onClick={handleNew} title="New file">+</button>
        </div>
        <div className="content-tree-list">
          {items.map(item => (
            <div
              key={item.filename}
              className={`content-tree-item ${selected === item.filename ? 'active' : ''}`}
              onClick={() => handleSelect(item.filename)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                <path d="M2 1.5h4.5L9 4v6.5H2V1.5Z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M6 1.5V4h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>{item.filename}</span>
            </div>
          ))}
          {items.length === 0 && (
            <div style={{ padding: '12px 8px', fontSize: 11, color: 'var(--text-muted)' }}>
              No files yet
            </div>
          )}
        </div>
      </div>

      {/* Content editor */}
      <div className="content-tree-main">
        {selected ? (
          <>
            <div className="content-tree-main-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  className="content-tree-toggle"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  title={sidebarOpen ? 'Hide files' : 'Show files'}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M2 3h10M2 7h10M2 11h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                </button>
                <span style={{ fontSize: 12.25, color: 'var(--text-primary)' }}>{selected}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handleSave} className="memory-edit-btn" disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={handleDelete} className="danger">Delete</button>
              </div>
            </div>
            <textarea
              className="content-tree-editor"
              value={content}
              onChange={e => setContent(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); } }}
            />
          </>
        ) : (
          <div className="empty-state">
            <span>No shared content yet</span>
            <button onClick={handleNew}>Create a file</button>
          </div>
        )}
      </div>
    </div>
  );
}
