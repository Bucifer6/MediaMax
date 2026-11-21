/**
 * The signed-out backdrop: an abstract, slowly drifting field of light in the theme's colours. Deliberately no
 * library artwork here: the login page is public and must not show what is on the server. An admin-set login
 * background (Branding Studio) is shown underneath instead when there is one.
 */
export function LightField({ image }: { image?: string | null }) {
  return (
    <div className="lightfield" aria-hidden="true">
      {image && <div className="lightfield-image" style={{ backgroundImage: `url("${image}")` }} />}
      <i className="lf-orb lf-a" />
      <i className="lf-orb lf-b" />
      <i className="lf-orb lf-c" />
      <i className="lf-orb lf-d" />
      <span className="lf-beam" />
      <span className="lf-grain" />
      <span className="lf-shade" />
    </div>
  );
}
