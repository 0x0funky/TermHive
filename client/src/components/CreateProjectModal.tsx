import { useState } from 'react';

interface Props {
  onClose: () => void;
  onCreate: (data: { name: string; cwd: string; description?: string }) => void;
}

export default function CreateProjectModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !cwd) return;
    onCreate({ name, cwd, description: description || undefined });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>New Project</h2>
        <form onSubmit={handleSubmit}>
          <label>Project Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. MyProject" autoFocus />

          <label>Working Directory</label>
          <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="e.g. /home/user/projects/myapp" />

          <label>Description (optional)</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description" />

          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!name || !cwd}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
