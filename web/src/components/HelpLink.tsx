import { Link } from 'react-router-dom';
import { helpPath } from '../utils/helpLinks';
import { Icon } from './Icon';

/** Small "?" button next to a page or card title that opens the matching Help Centre article. */
export function HelpLink({ slug, label, className }: { slug: string; label?: string; className?: string }) {
  return (
    <Link to={helpPath(slug)} className={`help-link ${className ?? ''}`} aria-label={label ? `Help: ${label}` : 'Help for this page'} title={label ? `Help: ${label}` : 'Help'} data-nav>
      <Icon name="help" size={18} />
    </Link>
  );
}
