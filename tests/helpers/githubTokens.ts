// GitHub App installation tokens as GitHub makes them since its 2026
// rollout (github.blog changelog 2026-04-24 and 2026-05-15): `ghs_`, the
// app's id, and a JWT — some 520 characters, of varying length, with dots.
// The old ones were 40 characters with no dots. Tests use these so that a
// length cap or a token-shaped pattern added anywhere on the way from
// GitHub to git fails a test rather than a person's push.

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A stateless-format installation token, distinct and stable for each `seed`. */
export function statelessToken(seed: string | number, appId = 123456): string {
  const header = part({ alg: "RS256", typ: "JWT", kid: `key-${seed}` });
  const claims = part({
    iss: appId,
    sub: `installation:7:${seed}`,
    aud: "api.github.com",
    iat: 1_763_208_000,
    exp: 1_763_211_600,
    repositories: ["acme/specs"],
    permissions: { contents: "write", metadata: "read" },
  });
  // A signature's worth of url-safe base64, its length varying with the seed.
  const signature = Buffer.alloc(256 + (String(seed).length % 4), String(seed)).toString("base64url");
  return `ghs_${appId}_${header}.${claims}.${signature}`;
}
