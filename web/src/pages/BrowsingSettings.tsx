import type { UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Switch } from '../components/ui';

/**
 * Trailer previews (home banner and poster hover). Off unless the viewer turns them on: autoplaying video is opt-in
 * (research: no autoplay by default), and always off when the device asks for reduced motion.
 */
export function PreviewSetting() {
  const { user, setUser } = useApp();
  const toast = useToast();
  if (!user) return null;
  const save = async (patch: Partial<UserPreferences>) => {
    setUser({ ...user, preferences: { ...user.preferences, ...patch } });
    try {
      setUser(await api.auth.updateMe({ preferences: patch }));
    } catch (e) {
      setUser(user);
      toast.error(e);
    }
  };
  return (
    <Switch
      checked={user.preferences.autoplayPreviews === true}
      onChange={(v) => void save({ autoplayPreviews: v })}
      label="Play trailer previews"
      hint="Play trailers silently in the home banner and when you hover over a poster. Off by default, and always off when your device asks for reduced motion."
    />
  );
}

/** Settings → Browsing (now part of Display): home-screen discovery preferences. */
export function BrowsingSettings() {
  return (
    <div className="settings-card">
      <h2>Browsing</h2>
      <div className="switch-group">
        <PreviewSetting />
      </div>
    </div>
  );
}
