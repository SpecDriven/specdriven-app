// Where the running build's source lives (specs/app/open-source-license.feature.md).
// The app is AGPL-3.0-only, and §13 asks a network-served copy — the public
// demo, the hosted service — to offer its users the Corresponding Source.
// Every release publishes a source zip of that exact version on the public
// release repository, so the default points at that release. A deployment
// that runs modified code names its own source with SPECDRIVEN_SOURCE_URL.

import { version as appVersion } from "../../package.json";

export const RELEASE_REPO_URL = "https://github.com/SpecDriven/specdriven-app-release";

export function sourceUrl(version: string = appVersion): string {
  const override = process.env.SPECDRIVEN_SOURCE_URL?.trim();
  if (override) return override;
  return `${RELEASE_REPO_URL}/releases/tag/v${version}`;
}
