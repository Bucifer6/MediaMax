import type { UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Switch } from '../components/ui';

/** Settings → Browsing: home-screen discovery preferences (kept apart from the player settings). */
export function BrowsingSettings() {
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
    <div className="settings-card">
      <h2>Browsing</h2>
      <div className="switch-group">
        <Switch
          checked={user.preferences.autoplayPreviews !== false}
          onChange={(v) => void save({ autoplayPreviews: v })}
          label="Autoplay previews"
          hint="Play trailers silently in the home banner and when you hover over a poster. Always off when your device asks for reduced motion."
        />
      </div>
    </div>
  );
}
