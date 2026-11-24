import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import '../styles/screens-account.css';

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="page notfound">
      <div className="notfound-inner">
        <span className="notfound-code" aria-hidden="true">404</span>
        <h1>Page not found</h1>
        <p>The page you're looking for doesn't exist or has moved.</p>
        <div className="row-gap">
          <button type="button" className="btn" onClick={() => navigate(-1)}><Icon name="arrowLeft" size={16} /> Go back</button>
          <Link className="btn btn-primary" to="/"><Icon name="home" size={16} /> Go home</Link>
        </div>
      </div>
    </div>
  );
}
