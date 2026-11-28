// The Specs tab's pane (src/plugins/builtin/specs/client.tsx): the open
// feature's page; its scenario's editor, or that scenario's page on a folder
// that cannot be written; and a skeleton while a feature opened by a link is
// still on its way.

import type { TabApp } from "../../plugins/client/tabs";
import { PageSkeleton } from "../Skeleton";
import { FeaturePage } from "./FeaturePage";
import { specsHost } from "./host";
import { useOpenFeature } from "./openFeature";
import { ScenarioEditor } from "./ScenarioEditor";
import { ScenarioPage } from "./ScenarioPage";

export function SpecsPane({ app }: { app: TabApp }) {
  const { selected, feature, editing } = useOpenFeature();
  const actions = specsHost()?.actions;
  if (!actions) return null;
  if (!selected || !feature) return <PageSkeleton cards={3} />;
  if (!editing) return <FeaturePage app={app} actions={actions} />;
  return actions.locked ? (
    <ScenarioPage app={app} actions={actions} />
  ) : (
    <ScenarioEditor app={app} actions={actions} />
  );
}
