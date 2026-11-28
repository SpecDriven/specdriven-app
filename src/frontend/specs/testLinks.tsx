// The editor pane's "Automated tests" field (specs/traceability.feature.md):
// reading a test's name from the code on GitHub as its url is typed,
// adding, editing and removing a link, and the table of links a scenario
// ends with. Moved out of App.tsx as they were, into a hook App.tsx calls:
// each handler sees the same render's values it saw there.

import { type RefObject, useEffect } from "react";
import {
  type TestDraft,
  addTestLink,
  canSetTestLink,
  removeTestLink,
  testDraftOf,
  testLinkHint,
  testLinkLabel,
  testLinkProblem,
  testLinkUrl,
  updateTestLink,
} from "../testlinks";
import {
  setTestDraft,
  setTestEdit,
  setTestEditDraft,
  setTestNameDraft,
  setTestNameHint,
  useEditorState,
} from "./editorState";
import { useOpenFeature } from "./openFeature";

export interface TestLinksDeps {
  setTests: (tests: string[]) => void;
  testEditOpened: RefObject<TestDraft>;
  testLookup: RefObject<number>;
}

export function useTestLinks(deps: TestLinksDeps) {
  const { editing } = useOpenFeature();
  const { testDraft, testEdit, testEditDraft, testNameDraft } = useEditorState();
  const {
    setTests,
    testEditOpened,
    testLookup,
  } = deps;
  /**
   * Fill a Name field from the code on GitHub (specs/external-links/
   * test-traceability.feature.md "the test name is read from the code on
   * GitHub"): the latest lookup wins, and every way of finding nothing —
   * a private repository, a language the server doesn't read, no test near
   * the line — becomes a hint under the field while the link stays.
   */
  const lookupTestName = (url: string, apply: (name: string) => void) => {
    const id = ++testLookup.current;
    setTestNameHint("Reading the test name from GitHub…");
    void (async () => {
      let name: string | null = null;
      let reason = "Could not read the test name — is the server running?";
      try {
        const res = await fetch(`/api/test-name?url=${encodeURIComponent(url)}`);
        const data = (await res.json()) as { name?: string | null; reason?: string; error?: string };
        name = data.name ?? null;
        reason = data.reason ?? data.error ?? reason;
      } catch {
        // keep the generic reason
      }
      if (id !== testLookup.current) return;
      if (name) {
        apply(name);
        setTestNameHint(null);
      } else {
        setTestNameHint(reason);
      }
    })();
  };

  // A url with a #L anchor typed into the add field is looked up a moment
  // after typing stops; a name already typed by hand is left alone.
  useEffect(() => {
    if (!editing) return;
    const url = testDraft.trim();
    if (!url || testLinkProblem(editing.scenario.tests, null, { url, name: "" }) !== null) {
      // Nothing to look up: a hint from an earlier url no longer applies,
      // and a GitHub url still missing its #L anchor says so right away.
      testLookup.current++;
      setTestNameHint(testLinkHint(url));
      return;
    }
    const timer = setTimeout(
      () => lookupTestName(url, (name) => setTestNameDraft((current) => (current.trim() ? current : name))),
      400,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testDraft]);

  // The same for an ✎ row whose url was changed: the name it opened with
  // belongs to the old url, so it is replaced; one typed since is kept.
  useEffect(() => {
    if (!editing || testEdit === null) return;
    const url = testEditDraft.url.trim();
    if (url === testEditOpened.current.url) return;
    if (testLinkProblem(editing.scenario.tests, testEdit, { url, name: "" }) !== null) {
      testLookup.current++;
      setTestNameHint(testLinkHint(url));
      return;
    }
    const timer = setTimeout(
      () =>
        lookupTestName(url, (name) =>
          setTestEditDraft((current) => {
            const typed = current.name.trim() && current.name !== testEditOpened.current.name;
            return typed ? current : { ...current, name };
          }),
        ),
      400,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testEditDraft.url, testEdit]);

  /** Forget a lookup still in flight, so it cannot land in the next row's fields. */
  const cancelTestLookup = () => {
    testLookup.current++;
    setTestNameHint(null);
  };

  const addTest = () => {
    const draft = { url: testDraft, name: testNameDraft };
    if (!editing || !canSetTestLink(editing.scenario.tests, null, draft)) return;
    setTests(addTestLink(editing.scenario.tests, draft));
    setTestDraft("");
    setTestNameDraft("");
    cancelTestLookup();
  };

  /** Open a row for in-place editing, seeded with the url and name it holds. */
  const startTestEdit = (index: number) => {
    if (!editing) return;
    const draft = testDraftOf(editing.scenario.tests[index] ?? "");
    testEditOpened.current = draft;
    setTestEdit(index);
    setTestEditDraft(draft);
    cancelTestLookup();
  };

  const commitTestEdit = () => {
    if (!editing || testEdit === null) return;
    if (!canSetTestLink(editing.scenario.tests, testEdit, testEditDraft)) return;
    setTests(updateTestLink(editing.scenario.tests, testEdit, testEditDraft));
    setTestEdit(null);
    cancelTestLookup();
  };

  const removeTest = (index: number) => {
    if (!editing) return;
    setTests(removeTestLink(editing.scenario.tests, index));
    // The rows below shift up one, so an open ✎ row would now point elsewhere.
    setTestEdit(null);
  };

  /** The clickable test-links table at the end of a scenario
      (specs/traceability.feature.md). */
  const testsTable = (tests: string[]) =>
    tests.length > 0 && (
      <table className="scenario-tests">
        <thead>
          <tr>
            <th>Automated tests</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t}>
              <td>
                <a
                  href={testLinkUrl(t)}
                  target="_blank"
                  rel="noreferrer"
                  title={testLinkUrl(t)}
                  data-test-link=""
                >
                  {testLinkLabel(t)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return {
    addTest,
    cancelTestLookup,
    commitTestEdit,
    removeTest,
    startTestEdit,
    testsTable,
  };
}
