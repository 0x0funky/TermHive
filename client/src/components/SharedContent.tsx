/**
 * Shared Content panel — tree (folders + files) on the left, preview / editor on the right.
 * Supports nested paths (storage recurses into subdirectories).
 */

import { useState, useEffect, useMemo, Fragment } from 'react';
import * as api from '../api';
import Ic from './Icons';

interface Props {
  projectId: string;
  refreshTrigger?: number;
}

interface TreeNode {
  kind: 'folder' | 'file';
  name: string;         // leaf name (no slashes)
  path: string;         // full relative path (folder path or file path)
  children?: TreeNode[]; // for folders
  by?: string;          // for files
  updatedAt?: string;   // for files
  ext?: string;
}

function buildTree(items: api.SharedContent[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderIndex = new Map<string, TreeNode>();

  const ensureFolder = (fullPath: string, name: string): TreeNode => {
    const existing = folderIndex.get(fullPath);
    if (existing) return existing;
    const folder: TreeNode = { kind: 'folder', name, path: fullPath, children: [] };
    folderIndex.set(fullPath, folder);
    return folder;
  };

  for (const item of items) {
    const parts = item.filename.split('/');
    if (parts.length === 1) {
      const ext = parts[0].includes('.') ? parts[0].split('.').pop()! : '';
      root.push({
        kind: 'file',
        name: parts[0],
        path: item.filename,
        by: item.createdBy,
        updatedAt: item.updatedAt,
        ext,
      });
    } else {
      let prefix = '';
      let parentChildren = root;
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? prefix + '/' + parts[i] : parts[i];
        let folder = folderIndex.get(prefix);
        if (!folder) {
          folder = ensureFolder(prefix, parts[i]);
          parentChildren.push(folder);
        }
        parentChildren = folder.children!;
      }
      const leaf = parts[parts.length - 1];
      const ext = leaf.includes('.') ? leaf.split('.').pop()! : '';
      parentChildren.push({
        kind: 'file',
        name: leaf,
        path: item.filename,
        by: item.createdBy,
        updatedAt: item.updatedAt,
        ext,
      });
    }
  }

  // Sort: folders first, then files, alpha within each group
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.kind === 'folder' && n.children) sortRec(n.children);
    }
  };
  sortRec(root);

  return root;
}

function timeAgo(ts: string | undefined): string {
  if (!ts) return '';
  const diffMs = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  return days + 'd';
}

const EXT_COLOR: Record<string, string> = {
  md: 'oklch(70% 0.08 190)',
  json: 'oklch(72% 0.11 80)',
  fig: 'oklch(68% 0.12 310)',
  png: 'oklch(66% 0.10 145)',
  jpg: 'oklch(66% 0.10 145)',
  log: 'oklch(62% 0.08 25)',
  txt: 'oklch(62% 0 0)',
};

function TreeNodeView({
  node, depth, selectedPath, onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  if (node.kind === 'folder') {
    return (
      <>
        <button
          className="tr-row folder"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen(!open)}
        >
          <span className="tr-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
            <Ic.chevR size={10} />
          </span>
          <Ic.folder size={13} />
          <span className="tr-name">{node.name}</span>
          <span className="tr-meta">{node.children?.length || 0}</span>
        </button>
        {open && node.children && node.children.map(c => (
          <TreeNodeView
            key={c.path}
            node={c}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  }
  const extColor = EXT_COLOR[node.ext || ''] || 'var(--text-2)';
  const isActive = selectedPath === node.path;
  return (
    <button
      className={'tr-row file' + (isActive ? ' active' : '')}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(node.path)}
    >
      <span className="tr-caret" />
      <span className="tr-ext" style={{ color: extColor }}>{node.ext || '·'}</span>
      <span className="tr-name">{node.name}</span>
      <span className="tr-meta">{node.by} · {timeAgo(node.updatedAt)}</span>
    </button>
  );
}

export default function SharedContentView({ projectId, refreshTrigger }: Props) {
  const [items, setItems] = useState<api.SharedContent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reload = async () => {
    const list = await api.listContent(projectId);
    setItems(list);
  };

  useEffect(() => {
    setSelected(null);
    setItems([]);
    setContent('');
    setDirty(false);
    api.listContent(projectId).then(list => {
      setItems(list);
    });
  }, [projectId]);

  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    reload();
    if (selected) {
      api.getContent(projectId, selected).then(item => {
        if (item && !dirty) setContent(item.content);
      }).catch(() => {});
    }
  }, [refreshTrigger]);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    api.getContent(projectId, selected).then(item => {
      if (item) {
        setContent(item.content);
        setDirty(false);
      }
    }).catch(() => setContent(''));
  }, [projectId, selected]);

  const tree = useMemo(() => buildTree(items), [items]);

  const selectedItem = selected ? items.find(i => i.filename === selected) : null;

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    await api.updateContent(projectId, selected, content);
    setSaving(false);
    setDirty(false);
  };

  const handleNew = async () => {
    const filename = prompt('Filename (e.g. notes.md, or subdir/file.md):');
    if (!filename) return;
    await api.createContent(projectId, { filename, content: '' });
    await reload();
    setSelected(filename);
  };

  const handleDelete = async () => {
    if (!selected || !confirm(`Delete ${selected}?`)) return;
    await api.deleteContent(projectId, selected);
    setSelected(null);
    await reload();
  };

  return (
    <div className="panel">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Shared Content</h2>
          <span className="panel-sub">
            Files & folders agents drop for each other · {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <div className="panel-h-r">
          <button className="chip primary" onClick={handleNew}>
            <Ic.plus size={10} /> New file
          </button>
        </div>
      </div>
      <div className="shared-split">
        <div className="shared-tree scroll">
          {tree.length === 0 ? (
            <div style={{ padding: '24px 12px', color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>
              No files yet
            </div>
          ) : (
            tree.map(n => (
              <TreeNodeView
                key={n.path}
                node={n}
                depth={0}
                selectedPath={selected}
                onSelect={setSelected}
              />
            ))
          )}
        </div>
        <div className="shared-preview">
          {selectedItem ? (
            <>
              <div className="sp-h">
                <div className="sp-ic"><Ic.file size={22} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="sp-nm">{selected}</div>
                  <div className="sp-meta">
                    by <b>{selectedItem.createdBy}</b> · {timeAgo(selectedItem.updatedAt)} ago
                  </div>
                </div>
                <div className="grow" />
                <button className="chip" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                </button>
                <button className="chip" onClick={handleDelete}>Delete</button>
              </div>
              <div className="sp-body">
                <textarea
                  className="sp-editor"
                  value={content}
                  onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault(); handleSave();
                    }
                  }}
                />
              </div>
            </>
          ) : (
            <div className="sp-empty">
              <Ic.folder size={36} />
              <div>Select a file to preview / edit</div>
              <div style={{ fontSize: 11 }}>or <button className="chip" onClick={handleNew} style={{ display: 'inline-flex' }}><Ic.plus size={10} /> New file</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
