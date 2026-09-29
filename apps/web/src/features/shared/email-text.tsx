/**
 * An email address that may wrap before its "@" (and at hyphens), never in
 * the middle of a word. `<wbr>` rather than a zero-width space, so a copied
 * address is still the address.
 */
export function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@');
  if (at <= 0) return <>{email}</>;
  return (
    <>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </>
  );
}
