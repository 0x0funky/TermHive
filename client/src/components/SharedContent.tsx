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

  // Load file list when project changes or external refresh
  useEffect(() => {
    setSelected(null);
    setItems([]);
    setContent('');
    api.listContent(projectId).then(list => {
      setItems(list);
      if (list.length > 0) {
        setSelected(list[0].filename);
      }
    });
  }, [projectId]);

  // Auto-refresh file list when files change externally (agent writes)
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    api.listContent(projectId).then(list => {
      setItems(list);
      // Reload current file content if it's selected
      if (selected) {
        api.getContent(projectId, selected).then(item => {
          if (item) setContent(item.content);
        }).catch(() => {});
      }
    });
  }, [refreshTrigger]);

  // Load file content when selection changes
  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
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

  return (
    <div className="shared-content">
      <div className="content-tabs">
        {items.map(item => (
          <div
            key={item.filename}
            className={`content-tab ${selected === item.filename ? 'active' : ''}`}
            onClick={() => setSelected(item.filename)}
          >
            {item.filename}
          </div>
        ))}
        <button onClick={handleNew} style={{ fontSize: 11 }}>+ New File</button>
      </div>
      {selected ? (
        <div className="content-editor">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{selected}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSave} className="primary" disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={handleDelete} className="danger">Delete</button>
            </div>
          </div>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); } }}
          />
        </div>
      ) : (
        <div className="empty-state">
          <span>No shared content yet</span>
          <button onClick={handleNew}>Create a file</button>
        </div>
      )}
    </div>
  );
}
