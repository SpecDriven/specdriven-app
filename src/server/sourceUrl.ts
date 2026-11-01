// Where the running build's source lives (specs/app/open-source-license.feature.md).
// The app is open source (Apache-2.0), and every copy — the public demo, the
// hosted service — offers its users the source of the version it runs.
// Every release publishes a source zip of that exact version on the app's
// own public repository, so the default points at that release. A deployment
// that runs modified code names its own source with SPECDRIVEN_SOURCE_URL.

import { version as appVersion } from "../../package.json";

export const RELEASE_REPO_URL = "https://github.com/SpecDriven/specdriven-app";

export function sourceUrl(version: string = appVersion): string {
  const override = process.env.SPECDRIVEN_SOURCE_URL?.trim();
  if (override) return override;
  return `${RELEASE_REPO_URL}/releases/tag/v${version}`;
}
