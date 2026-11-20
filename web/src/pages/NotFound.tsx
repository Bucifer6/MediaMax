import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <div className="page">
      <EmptyState icon="alert" title="Page not found" message="The page you're looking for doesn't exist." action={<Link className="btn btn-primary" to="/">Go home</Link>} />
    </div>
  );
}
