import { Check, Link } from "lucide-react";
import { Tooltip } from "./Tooltip";

/**
 * "Copy link" as an icon button (specs/ui/navigation.feature.md "share a
 * link"): a link icon that flips to a check mark while `copied`.
 */
export function CopyLinkButton({
  copied,
  onCopy,
  disabled,
  size = 16,
  keys,
  label = "Copy link",
}: {
  copied: boolean;
  onCopy: () => void;
  disabled?: boolean;
  size?: number;
  /** The shortcut, where mod+shift+c copies this same url. */
  keys?: string;
  label?: string;
}) {
  return (
    <Tooltip label={copied ? "Copied" : "Copy link"} keys={keys}>
      <button type="button" className="ibtn" aria-label={label} disabled={disabled} onClick={onCopy}>
        {copied ? <Check size={size} aria-hidden="true" /> : <Link size={size} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
