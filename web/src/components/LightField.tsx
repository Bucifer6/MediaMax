import '../styles/screens-account.css';

/**
 * The signed-out backdrop: a calm, static wash of the brand gradient (it follows the theme's accent colours), with no
 * drift and deliberately no library artwork (the sign-in page is public and must not show what is on the server).
 * An admin-set login background (Branding Studio) is shown underneath instead when there is one.
 */
export function LightField({ image }: { image?: string | null }) {
  return (
    <div className="vbg" aria-hidden="true">
      {image && <div className="vbg-image" style={{ backgroundImage: `url("${image}")` }} />}
      <span className="vbg-wash" />
      <span className="vbg-shade" />
    </div>
  );
}
