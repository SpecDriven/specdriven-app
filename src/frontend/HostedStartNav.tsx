// The hosted app's way out of its start screens (specs/app/hosted-app.feature.md
// "The start screen leads to the account and admin pages"): before a specs
// repo opens there is no user menu, so the screen itself links to the
// gateway's account page, the admin page for admins, and signing out. Those
// pages are the gateway's (src/gateway) and need no repo.

export interface HostedAccount {
  email: string | null;
  admin: boolean;
}

/** What to do about a clone the hosted worker could not make, or null. */
export function hostedCloneHint(error: string | null): string | null {
  if (!error) return null;
  if (/write access to repository not granted|returned error: 40[13]|authentication (failed|required)/i.test(error)) {
    return "The GitHub token on your account page cannot read and write this repository: give it access, or replace it.";
  }
  return null;
}

export function HostedStartNav({ account, onSignOut }: { account: HostedAccount; onSignOut: () => void }) {
  return (
    <nav className="hosted-start-nav" aria-label="Account">
      {account.email && <span className="hosted-start-who">Signed in as {account.email}</span>}
      <span className="hosted-start-links">
        <a href="/account">Account &amp; tokens</a>
        {account.admin && <a href="/admin">Admin</a>}
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </span>
    </nav>
  );
}
