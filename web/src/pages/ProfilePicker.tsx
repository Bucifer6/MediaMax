import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AccountProfile } from '@mediamax/shared';
import { useApp } from '../state/app';
import { profilesApi } from '../api/profiles';
import { ApiRequestError, errorMessage } from '../api/client';
import { realtime } from '../api/ws';
import { Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { LightField } from '../components/LightField';
import { isCalm } from '../theme/fx';
import { ProfileAvatar } from '../components/ProfileEditor';
import { PinPad } from './Login';
import '../styles/profiles.css';
import { safeNext } from '../utils/safeNext';

/**
 * "Who's watching?" — shown after signing in to an account that has profiles, and from "Switch profile".
 * Big focusable tiles (D-pad friendly in TV mode); PIN-protected profiles ask for their PIN.
 */
export default function ProfilePicker() {
  const { user, branding, login, logout } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [list, setList] = useState<AccountProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<AccountProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    profilesApi.account().then(setList).catch((e) => setError(errorMessage(e)));
  }, []);
  // Focus the current profile (or the first) so a TV remote can start straight away.
  useEffect(() => {
    if (!list || pinFor) return;
    const el = grid.current?.querySelector<HTMLElement>('.pp-tile.current') ?? grid.current?.querySelector<HTMLElement>('.pp-tile');
    el?.focus();
  }, [list, pinFor]);

  const [chosen, setChosen] = useState<string | null>(null);
  const enter = async (p: AccountProfile, pin?: string) => {
    setError(null);
    if (!pin) {
      if (chosen) return;
      // Selection animation: the chosen profile steps forward while the others fall away.
      setChosen(p.id);
      if (!isCalm()) await new Promise((r) => window.setTimeout(r, 360));
      setChosen(null);
    }
    if (p.current) return navigate(next, { replace: true });
    if (p.hasPin && !pin) return setPinFor(p);
    setBusy(true);
    try {
      const auth = await profilesApi.switchTo(p.id, pin);
      realtime.disconnect();
      login(auth);
      navigate(next, { replace: true });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'pin_required') setPinFor(p);
      else setError(e instanceof ApiRequestError && e.status === 401 ? 'Incorrect PIN' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const isProfileSession = !!user?.parentUserId;
  const bg = branding.loginBackgroundUrl;
  return (
    <div className="login vibe-auth profile-picker">
      <LightField image={bg} />
      <div className="login-inner">
        <div className="login-brand"><BrandLogo height={44} wide={!branding.logoUrl || !!branding.logoWideUrl} /></div>
        {!list && !error ? (
          <Spinner size={36} />
        ) : pinFor ? (
          <div className="login-card glass fade-in pp-pin">
            <button className="btn-icon login-back" onClick={() => { setPinFor(null); setError(null); }} aria-label="Back to profiles">
              <Icon name="arrowLeft" />
            </button>
            <ProfileAvatar name={pinFor.displayName} url={pinFor.avatarUrl} color={pinFor.color} size={88} kids={pinFor.isKids} />
            <h2>{pinFor.displayName}</h2>
            <p className="muted">{pinFor.isOwner && user?.isKids ? 'Enter the account PIN to leave the kids profile' : 'Enter the profile PIN'}</p>
            <PinPad length={pinFor.pinLength ?? 4} onComplete={(pin) => void enter(pinFor, pin)} error={error} busy={busy} />
          </div>
        ) : (
          <div className="profiles pp fade-in">
            <h1>Who's watching?</h1>
            <div className={`profile-grid pp-grid ${chosen ? 'choosing' : ''}`} ref={grid}>
              {(list ?? []).map((p, i) => (
                <button key={p.id} className={`profile pp-tile ${p.current ? 'current' : ''} ${chosen === p.id ? 'chosen' : ''}`} style={{ '--i': i } as React.CSSProperties} data-nav onClick={() => void enter(p)} disabled={busy} aria-disabled={!!chosen || undefined} aria-label={`${p.displayName}${p.isKids ? ' (kids)' : ''}${p.hasPin ? ', PIN protected' : ''}${p.current ? ', signed in' : ''}`}>
                  <span className="pp-art">
                    <ProfileAvatar name={p.displayName} url={p.avatarUrl} color={p.color} size={132} kids={p.isKids} />
                    {p.current && <span className="profile-current" aria-hidden="true"><Icon name="check" size={14} /></span>}
                    {p.hasPin && !p.current && <span className="profile-lock" title="PIN protected"><Icon name="lock" size={14} /></span>}
                  </span>
                  <span className="profile-name">{p.displayName}</span>
                  <span className="profile-sub">{p.current ? 'Signed in' : ''}</span>
                </button>
              ))}
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="row-gap pp-actions">
              {!isProfileSession && (
                <button className="btn btn-glass" data-nav onClick={() => navigate('/settings/profiles')}>
                  <Icon name="edit" size={16} /> Manage profiles
                </button>
              )}
              <button className="btn btn-ghost" data-nav onClick={() => void logout().then(() => navigate('/login'))}>
                <Icon name="logout" size={16} /> Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
