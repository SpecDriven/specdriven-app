// Automates specs/external-links/project-management-jira-linear-etc.feature.md
// "Several tickets on a feature" in the browser: the feature header's
// tickets field — each ticket a link with a ✕, the add row while there is
// room, the count, and what is refused.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketLinkField } from "../src/frontend/TicketLinkField";

const ticket = (n: number) => ({ program: "Jira", ticket: `ABC-${n}`, url: `https://acme.atlassian.net/browse/ABC-${n}` });

describe("the Tickets field", () => {
  test("lists the tickets as links with a remove button each, and an add row with the count", () => {
    const html = renderToStaticMarkup(<TicketLinkField links={[ticket(1), ticket(2)]} tool="Jira" onChange={() => {}} />);
    expect(html).toContain(">Jira:ABC-1</a>");
    expect(html).toContain(">Jira:ABC-2</a>");
    expect(html).toContain(`href="${ticket(1).url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('aria-label="Remove Jira:ABC-2"');
    expect(html).toContain('aria-label="Ticket url"');
    expect(html).toContain("2 of 5 tickets linked.");
    // Nothing typed yet: Add is disabled, and classed like every button.
    expect(html).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Add<\/button>/);
  });

  test("with none, only the add row; with the tool set in Settings, the url alone is asked for", () => {
    const html = renderToStaticMarkup(<TicketLinkField links={[]} tool="Jira" onChange={() => {}} />);
    expect(html).not.toContain("ticket-list");
    expect(html).toContain("0 of 5 tickets linked.");
    expect(html).toContain('aria-label="Ticket url"');
    expect(html).not.toContain('aria-label="Tool"');
    const free = renderToStaticMarkup(<TicketLinkField links={[]} onChange={() => {}} />);
    expect(free).toContain('aria-label="Tool"');
  });

  test("at five the add row gives way to the count and how to make room", () => {
    const html = renderToStaticMarkup(
      <TicketLinkField links={[1, 2, 3, 4, 5].map(ticket)} tool="Jira" onChange={() => {}} />,
    );
    expect(html).not.toContain('aria-label="Ticket url"');
    expect(html).not.toContain(">Add<");
    expect(html).toContain("5 of 5 tickets linked — remove one to link another.");
    expect(html.match(/aria-label="Remove Jira:ABC-\d"/g)).toHaveLength(5);
  });

  test("the server's refusal shows under the fields, and saving disables the buttons", () => {
    const html = renderToStaticMarkup(
      <TicketLinkField links={[ticket(1)]} tool="Jira" error="A ticket is listed twice" saving onChange={() => {}} />,
    );
    expect(html).toContain('<p class="error">A ticket is listed twice</p>');
    expect(html).toMatch(/aria-label="Remove Jira:ABC-1" disabled=""/);
    expect(html).toContain(">Saving…</button>");
  });
});
