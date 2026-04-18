/**
 * Project Wiki panel — TOC on the left (metadata/core/agents/raw + recent log entries),
 * article body on the right. Supports click-to-navigate internal markdown links.
 */

import { useState, useEffect } from 'react';
import { marked } from 'marked';
import * as api from '../api';
import Ic from './Icons';

marked.setOptions({ gfm: true, breaks: true });

interface Props {
  projectId: string;
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

function parseLog(content: string): { date: string; action: string; summary: string }[] {
  const entries: { date: string; action: string; summary: string }[] = [];
  const regex = /^## \[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*\|\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ date: match[1], action: match[2], summary: match[3] });
  }
  return entries.reverse();
}

const WIKI_ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  book: Ic.book,
  rules: Ic.hash,
  log: Ic.activity,
  doc: Ic.file,
  user: Ic.user,
};

function pickIcon(name: string) {
  if (name === '_index.md') return WIKI_ICONS.book;
  if (name === '_schema.md') return WIKI_ICONS.rules;
  if (name === '_log.md') return WIKI_ICONS.log;
  if (name.startsWith('agents/')) return WIKI_ICONS.user;
  return WIKI_ICONS.doc;
}

export default function ProjectWiki({ projectId }: Props) {
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
    api.getWikiStatus(projectId).then(s => {
      setInitialized(s.initialized);
      if (s.initialized) loadFiles();
    });
  }, [projectId]);

  const loadFiles = async () => {
    const list = await api.listWikiFiles(projectId);
    setFiles(list);
    if (list.length > 0 && !selected) {
      const def = list.find(f => f.filename === '_index.md')
        || list.find(f => f.filename === 'overview.md')
        || list[0];
      setSelected(def.filename);
    }
    try {
      const log = await api.getWikiFile(projectId, '_log.md');
      if (log) setLogEntries(parseLog(log.content));
    } catch { /* no log yet */ }
  };

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    setEditing(false);
    api.getWikiFile(projectId, selected).then(item => {
      if (item) setContent(item.content);
    }).catch(() => setContent(''));
  }, [projectId, selected]);

  const handleInit = async () => {
    await api.initializeWiki(projectId);
    setInitialized(true);
    await loadFiles();
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    await api.updateWikiFile(projectId, selected, content);
    setSaving(false);
    setEditing(false);
    if (selected === '_log.md') setLogEntries(parseLog(content));
  };

  if (initialized === null) {
    return (
      <div className="panel">
        <div className="panel-empty">Loading…</div>
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="panel">
        <div className="panel-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 440, padding: 32 }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12, color: 'var(--text-0)' }}>Project Wiki</h3>
            <p style={{ fontSize: 13, color: 'var(--text-1)', marginBottom: 20, lineHeight: 1.6 }}>
              Initialize a persistent wiki for this project. AI agents will maintain architecture docs, API specs, decisions, and progress — following Karpathy's LLM Wiki pattern.
            </p>
            <button className="batch-btn primary" onClick={handleInit}>
              <Ic.plus size={11} /> Initialize Wiki
            </button>
          </div>
        </div>
      </div>
    );
  }

  const metaFiles = files.filter(f => f.filename.startsWith('_'));
  const coreFiles = files.filter(f => !f.filename.startsWith('_') && !f.filename.includes('/'));
  const agentFiles = files.filter(f => f.filename.startsWith('agents/'));
  const rawFiles = files.filter(f => f.filename.startsWith('raw/'));

  const selectedFile = selected ? files.find(f => f.filename === selected) : null;

  const renderSection = (title: string, items: api.SharedContent[]) =>
    items.length === 0 ? null : (
      <>
        <div className="wiki-sec-h">{title}</div>
        {items.map(f => {
          const IconC = pickIcon(f.filename);
          const displayName = f.filename.replace(/^(agents|raw)\//, '');
          return (
            <button
              key={f.filename}
              className={'wiki-item' + (selected === f.filename ? ' active' : '')}
              onClick={() => setSelected(f.filename)}
            >
              <div className="ic"><IconC size={12} /></div>
              <div className="ln">{displayName}</div>
              {f.updatedAt && <div className="tag">{timeAgo(f.updatedAt)}</div>}
            </button>
          );
        })}
      </>
    );

  return (
    <div className="panel wiki-panel">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Project Wiki</h2>
          <span className="panel-sub">
            Long-term memory · {files.length} {files.length === 1 ? 'page' : 'pages'}
          </span>
        </div>
        <div className="panel-h-r">
          {editing ? (
            <>
              <button className="chip" onClick={() => {
                setEditing(false);
                if (selected) api.getWikiFile(projectId, selected).then(i => { if (i) setContent(i.content); });
              }}>Cancel</button>
              <button className="chip primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            selected && <button className="chip" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
      </div>
      <div className="wiki-split">
        <aside className="wiki-toc scroll">
          {renderSection('Index', metaFiles)}
          {renderSection('Core', coreFiles)}
          {renderSection('Agents', agentFiles)}
          {renderSection('Raw', rawFiles)}
          {logEntries.length > 0 && (
            <>
              <div className="wiki-sec-h" style={{ marginTop: 12 }}>Recent Activity</div>
              {logEntries.slice(0, 8).map((entry, i) => (
                <div key={i} style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>
                  <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: 'var(--text-3)', marginRight: 6 }}>
                    {entry.date}
                  </span>
                  {entry.summary}
                </div>
              ))}
            </>
          )}
        </aside>
        <article className="wiki-article scroll">
          {selected && selectedFile ? (
            editing ? (
              <textarea
                className="sp-editor"
                style={{ padding: 0, minHeight: 400 }}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault(); handleSave();
                  }
                }}
              />
            ) : (
              <>
                <div className="wiki-crumb">Wiki · <span>{selected}</span></div>
                <h1 className="wiki-title">{selected.replace(/\.md$/, '').replace(/^[_/]+/, '')}</h1>
                {selectedFile.updatedAt && (
                  <div className="wiki-meta">Last edited {timeAgo(selectedFile.updatedAt)}</div>
                )}
                <div
                  className="wiki-body"
                  dangerouslySetInnerHTML={{ __html: marked(content) as string }}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.tagName === 'A') {
                      e.preventDefault();
                      const href = target.getAttribute('href') || '';
                      if (href.endsWith('.md') && !href.startsWith('http')) {
                        const currentDir = selected.includes('/') ? selected.split('/').slice(0, -1).join('/') : '';
                        const resolved = currentDir && !href.startsWith('/') ? currentDir + '/' + href : href;
                        const found = files.find(f => f.filename === resolved) || files.find(f => f.filename === href);
                        if (found) setSelected(found.filename);
                      }
                    }
                  }}
                />
              </>
            )
          ) : (
            <div className="panel-empty">Select a page</div>
          )}
        </article>
      </div>
    </div>
  );
}
