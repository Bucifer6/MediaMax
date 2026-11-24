import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { PosterCard, CardSkeleton } from '../components/Cards';
import { EmptyState, ErrorState, Modal, Field, PageHeader } from '../components/ui';
import { Icon } from '../components/Icon';
import { SmartListModal } from '../components/SmartListModal';
import '../styles/screens-browse.css';

export default function ContainersPage({ kind }: { kind: 'playlists' | 'collections' }) {
  const { user } = useApp();
  const toast = useToast();
  const res = useAsync(() => (kind === 'playlists' ? api.playlists.list() : api.collections.list()), [kind]);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [smart, setSmart] = useState(false);
  const [title, setTitle] = useState('');
  const [overview, setOverview] = useState('');
  const canCreate = kind === 'playlists' || user?.isAdmin;

  const create = async () => {
    try {
      if (kind === 'playlists') await api.playlists.create({ title });
      else await api.collections.create({ title, overview: overview || undefined });
      setCreating(false);
      setTitle('');
      setOverview('');
      res.reload();
      toast.success('Created');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="page containers-page">
      <PageHeader
        title={kind === 'playlists' ? 'Playlists' : 'Collections'}
        subtitle={res.data?.length ? <span className="tabular">{res.data.length} {kind === 'playlists' ? (res.data.length === 1 ? 'playlist' : 'playlists') : res.data.length === 1 ? 'collection' : 'collections'}</span> : kind === 'playlists' ? 'Your mixes of movies, episodes and songs' : 'Related titles, grouped'}
        actions={canCreate && (
          <>
            <button className="btn btn-ghost" onClick={() => setSmart(true)}>
              <Icon name="wand" size={16} /> New smart {kind === 'playlists' ? 'playlist' : 'collection'}
            </button>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> New {kind === 'playlists' ? 'playlist' : 'collection'}
            </button>
          </>
        )}
      />
      {res.loading && !res.data ? (
        <div className="grid grid-poster">{Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} shape={kind === 'playlists' ? 'square' : 'poster'} />)}</div>
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !res.data?.length ? (
        <EmptyState
          icon={kind === 'playlists' ? 'playlist' : 'collection'}
          title={`No ${kind} yet`}
          message={kind === 'playlists' ? 'Build playlists from any movie, episode or song using the + button on its page.' : 'Collections group related titles, like a film franchise.'}
        />
      ) : (
        <div className={`grid grid-${kind === 'playlists' ? 'square' : 'poster'}`}>
          {res.data.map((i) => (
            <div key={i.id} className="grid-cell">
              <PosterCard item={i} width="100%" shape={kind === 'playlists' ? 'square' : 'poster'} />
              {i.smart && <span className="smart-chip" title="Smart list: updates automatically"><Icon name="wand" size={12} /> Smart</span>}
            </div>
          ))}
        </div>
      )}
      {canCreate && (
        <SmartListModal
          open={smart}
          onClose={() => setSmart(false)}
          kind={kind === 'playlists' ? 'playlist' : 'collection'}
          onSaved={(it) => { res.reload(); navigate(`/item/${it.id}`); }}
        />
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={`New ${kind === 'playlists' ? 'playlist' : 'collection'}`}
        size="sm"
        footer={<><button className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button><button className="btn btn-primary" disabled={!title.trim()} onClick={create}>Create</button></>}
      >
        <div className="form-grid">
          <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
          {kind === 'collections' && <Field label="Description"><textarea className="textarea" rows={3} value={overview} onChange={(e) => setOverview(e.target.value)} /></Field>}
        </div>
      </Modal>
    </div>
  );
}
