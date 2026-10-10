// The spec-proposals page (src/proposals.html, served in proposals mode —
// specs/app/spec-proposals.feature.md). A page of its own rather than the
// app with its controls hidden: the service can only read and add, so it
// ships none of the editor.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import { createRoot } from "react-dom/client";
import { ProposalsApp } from "./ProposalsApp";

createRoot(document.getElementById("root")!).render(<ProposalsApp />);
