// What the Confluence MCP server answers, apart from the wire
// (specs/external-links/confluence-wiki.feature.md "An agent session can
// read the wiki"): which saved wiki a call means, the page a url or an id
// names, and the text a tool hands back. Pure and free of the MCP SDK, so
// the core (src/server/agentMcp.ts) shares the names without loading it.

import type { PageBody, PageHit } from "../server/confluence";
import type { ConfluenceTokenRecord } from "../server/confluenceTokens";
import { parseParentPageUrl, sameBase, type ParentPageRef } from "../server/confluenceUrl";

/** The server's name: its tools reach the agent as `mcp__specdriven-confluence__<tool>`. */
export const CONFLUENCE_MCP_SERVER = "specdriven-confluence";

/** Where the server reads its tokens from; unset, the app's own token file. */
export const CONFLUENCE_TOKENS_FILE_ENV = "SPECDRIVEN_CONFLUENCE_TOKENS_FILE";

/** How much of a page's text one call hands back. */
export const PAGE_TEXT_MAX = 60_000;

/** A refusal a tool answers with (`isError`), never a crash. */
export class ToolError extends Error {}

/** A saved wiki: its base url and the token for it. */
export type Wiki = Pick<ConfluenceTokenRecord, "base" | "token">;

const saved = (wikis: Wiki[]) => wikis.map((w) => w.base).join(", ");

/** The saved wiki a call means: the one `base` names, else the only one. */
export function wikiFor(wikis: Wiki[], base?: string): Wiki {
  if (wikis.length === 0) {
    throw new ToolError("No Confluence token is saved in SpecDriven — add one in Settings → Confluence.");
  }
  if (base) {
    const found = wikis.find((w) => sameBase(w.base, base));
    if (!found) throw new ToolError(`No token is saved for ${base}. Saved wikis: ${saved(wikis)}.`);
    return found;
  }
  if (wikis.length === 1) return wikis[0]!;
  throw new ToolError(`Several wikis are saved — pass base to say which. Saved wikis: ${saved(wikis)}.`);
}

/** How a call names a page: by its link, or by id on a wiki. */
export interface PageArgs {
  url?: string;
  id?: string;
  base?: string;
}

/** The page a call names and the wiki it is on. */
export function pageRef(wikis: Wiki[], args: PageArgs): { wiki: Wiki; ref: ParentPageRef } {
  if (args.url) {
    const ref = parseParentPageUrl(args.url);
    if (!ref) {
      throw new ToolError(
        `${args.url} is not a Confluence page link this server can read — expected …/spaces/KEY/pages/ID/Title, …/pages/viewpage.action?pageId=ID or …/display/KEY/Title.`,
      );
    }
    return { wiki: wikiFor(wikis, ref.base), ref };
  }
  if (args.id) {
    if (!/^\d+$/.test(args.id)) throw new ToolError(`A page id is a number; got "${args.id}".`);
    const wiki = wikiFor(wikis, args.base);
    return { wiki, ref: { base: wiki.base, pageId: args.id } };
  }
  throw new ToolError("Pass url (the page's link) or id (its page id, with base when several wikis are saved).");
}

/** The text cut to `max` characters, saying so. */
export function truncate(text: string, max = PAGE_TEXT_MAX): string {
  if (text.length <= max) return text;
  const n = (v: number) => v.toLocaleString("en-US");
  return `${text.slice(0, max)}\n\n[Truncated: ${n(max)} of ${n(text.length)} characters shown.]`;
}

/** Pages as a list the agent can pick from: title, link, id, space, who last changed it. */
export function hitLines(hits: PageHit[], none: string): string {
  if (hits.length === 0) return none;
  return hits
    .map((h) => {
      const by = h.by ? `, by ${h.by}` : "";
      const when = h.when ? ` on ${h.when.slice(0, 10)}` : "";
      return `- [${h.title}](${h.url}) — id ${h.id}, space ${h.spaceKey}${by}${when}`;
    })
    .join("\n");
}

/** A page as the agent reads it: where it is, then its body. */
export function pageText(page: PageBody, markdown: string): string {
  const where = [`id: ${page.id}`, ...(page.spaceKey ? [`space: ${page.spaceKey}`] : []), ...(page.version ? [`version: ${page.version}`] : [])];
  return `# ${page.title}\nurl: ${page.url}\n${where.join(" · ")}\n\n${truncate(markdown)}`;
}

/** What the server tells the model about itself on connect. */
export function serverInstructions(wikis: Wiki[]): string {
  const which =
    wikis.length === 0
      ? "No wiki has a token saved yet; every call will say so."
      : `Saved wikis: ${saved(wikis)}.${wikis.length > 1 ? " Pass base to pick one when a call takes no url." : ""}`;
  return [
    "Read-only access to the Confluence wikis the user saved a token for in SpecDriven.",
    which,
    "get_page reads a page by its link or id; search_pages finds pages by text; list_children lists a page's child pages.",
    "Cite a page by its url when you use what it says.",
  ].join(" ");
}
