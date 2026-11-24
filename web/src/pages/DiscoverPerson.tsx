import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DiscoverPerson, DiscoverResult, MediaRequest } from '@mediamax/shared';
import { arrApi } from '../api/arr';
import { seerrApi } from '../api/seerr';
import { useAsync } from '../hooks';
import { CardSkeleton } from '../components/Cards';
import { EmptyState, ErrorState, Img, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { DiscoverCard, keyOf, RequestModal, useCardActions } from '../components/DiscoverCards';
import '../styles/requests.css';

/** Person page: biography and filmography (cast & crew) with request buttons. */
export default function DiscoverPersonPage() {
  const { personId = '' } = useParams();
  const person = useAsync(() => seerrApi.person(personId), [personId]);
  const opts = useAsync(() => arrApi.requestOptions().catch(() => null), []);
  const [target, setTarget] = useState<DiscoverResult | null>(null);
  const update = (r: DiscoverResult, patch: Partial<DiscoverResult>) => person.setData((p) => p && ({
    ...p,
    cast: p.cast.map((x) => (keyOf(x) === keyOf(r) ? { ...x, ...patch } : x)),
    crew: p.crew.map((x) => (keyOf(x) === keyOf(r) ? { ...x, ...patch } : x)),
  } as DiscoverPerson));
  const actions = useCardActions(update, setTarget);
  const onDone = (r: DiscoverResult, req: MediaRequest) => {
    update(r, { requestId: req.id, requestStatus: req.status });
    setTarget(null);
  };
  const p = person.data;
  return (
    <div className="page discover-page">
      <p><Link to="/discover" className="btn btn-sm btn-ghost"><Icon name="arrowLeft" size={14} /> Discover</Link></p>
      {person.error ? <ErrorState message={person.error} onRetry={person.reload} /> : !p ? (
        <>
          <Skeleton h={200} />
          <div className="grid grid-poster" style={{ marginTop: 20 }}>{Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}</div>
        </>
      ) : (
        <>
          <header className="person-head">
            <div className="person-photo"><Img src={p.profileUrl} width={320} alt={p.name} fallback={<Icon name="user" size={40} />} /></div>
            <div className="person-bio">
              <h1 className="dp-name">{p.name}</h1>
              <p className="dp-facts">{[p.knownFor, p.birthday && `Born ${p.birthday}${p.placeOfBirth ? ` in ${p.placeOfBirth}` : ''}`, p.deathday && `Died ${p.deathday}`].filter(Boolean).join(' · ')}</p>
              {p.biography && <p>{p.biography}</p>}
            </div>
          </header>
          {!p.cast.length && !p.crew.length && <EmptyState icon="film" title="No titles found" />}
          {p.cast.length > 0 && (
            <>
              <h2 className="section-title">Appearances</h2>
              <div className="grid grid-poster discover-grid">
                {p.cast.map((r) => (
                  <div key={keyOf(r)} style={{ minWidth: 0 }}>
                    <DiscoverCard r={r} opts={opts.data ?? null} actions={actions} />
                    {r.character && <small className="muted" style={{ display: 'block', marginTop: 4 }}>as {r.character}</small>}
                  </div>
                ))}
              </div>
            </>
          )}
          {p.crew.length > 0 && (
            <>
              <h2 className="section-title" style={{ marginTop: 28 }}>Crew</h2>
              <div className="grid grid-poster discover-grid">
                {p.crew.map((r) => (
                  <div key={keyOf(r)} style={{ minWidth: 0 }}>
                    <DiscoverCard r={r} opts={opts.data ?? null} actions={actions} />
                    {r.job && <small className="muted" style={{ display: 'block', marginTop: 4 }}>{r.job}</small>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <RequestModal target={target} opts={opts.data ?? null} onClose={() => setTarget(null)} onDone={onDone} />
    </div>
  );
}
