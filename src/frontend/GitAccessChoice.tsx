// Settings → Git & GitHub's Git access (specs/app/user-info-settings.feature.md
// "Git access"): where git's GitHub credentials come from, one of three —
// the GitHub CLI (recommended), a personal access token, or the GitHub
// account sign-in, which is offered only while the "GitHub account" switch
// is on. The server maps the choice onto a git engine (src/server/git/access.ts).

export type GitAccess = "gh" | "token" | "account";

/** The access the radios show: the server's answer, else the GitHub CLI where installed. */
export function accessShown(value: unknown, ghInstalled: boolean, accountOffered: boolean): GitAccess {
  if (value === "gh" || value === "token") return value;
  if (value === "account") return accountOffered ? "account" : "token";
  return ghInstalled ? "gh" : "token";
}

export function GitAccessChoice({
  value,
  ghInstalled,
  accountOffered,
  disabled = false,
  onPick,
}: {
  value: GitAccess;
  ghInstalled: boolean;
  /** The "GitHub account" switch is on. */
  accountOffered: boolean;
  disabled?: boolean;
  onPick: (access: GitAccess) => void;
}) {
  const option = (
    access: GitAccess,
    label: React.ReactNode,
    hint: React.ReactNode,
    unavailable = false,
  ) => (
    <label className={`git-access-option${unavailable ? " unavailable" : ""}`}>
      <input
        type="radio"
        name="git-access"
        value={access}
        checked={value === access}
        disabled={disabled || unavailable}
        onChange={() => onPick(access)}
      />
      <span className="git-access-text">
        <span className="git-access-label">{label}</span>
        <span className="git-access-hint">{hint}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="git-access" aria-label="Git access">
      <legend className="git-access-legend">Git access</legend>
      <p className="git-access-note">
        The GitHub CLI (gh) is recommended: it uses the accounts you signed in to with{" "}
        <code>gh auth login</code>, on github.com and GitHub Enterprise alike.
      </p>
      {option(
        "gh",
        <>
          GitHub CLI (gh) <span className="git-access-badge">Recommended</span>
        </>,
        ghInstalled ? (
          "gh supplies the credentials and clones, on top of git on this computer."
        ) : (
          <>
            Not installed — get it from{" "}
            <a href="https://cli.github.com" target="_blank" rel="noreferrer">
              cli.github.com
            </a>
            .
          </>
        ),
        !ghInstalled,
      )}
      {option(
        "token",
        "GitHub Personal Access Token",
        "A token you paste below, for github.com or a GitHub Enterprise host.",
      )}
      {accountOffered &&
        option("account", "GitHub account sign-in", "Sign in to GitHub in the browser or with a device code. Preview.")}
    </fieldset>
  );
}
