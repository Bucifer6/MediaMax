import { Avatar } from './ui';
import '../styles/profiles.css';

/** Avatar tile for profiles: picture / built-in avatar / initials on the profile colour. */
export function ProfileAvatar({ name, url, color, size = 96, kids }: { name: string; url: string | null; color?: string | null; size?: number; kids?: boolean }) {
  return (
    <span className="profile-avatar" style={{ width: size, height: size, ['--pf-color' as string]: color ?? undefined }}>
      <Avatar name={name} url={url} size={size} />
      {kids && <span className="profile-kids-tag">Kids</span>}
    </span>
  );
}
