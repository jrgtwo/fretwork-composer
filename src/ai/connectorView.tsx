import { useSyncExternalStore } from 'react';
import {
  getConnectorSettings,
  subscribeToConnectorSettings,
  type ConnectorSettings,
} from './connectorSettings';

/**
 * The React view of the connector store, and the only one.
 *
 * ── Why it is a file of its own ─────────────────────────────────────────────
 *
 * It cannot live beside the store: `connectorSettings.ts` is a `.ts` under
 * `src/ai`, and the tripwire in `tests/AgentTools.test.ts` allows those to
 * import the seams and their own siblings and nothing else — `react` included.
 * That is the rule that keeps the agent's own layer free of the lib, and a hook
 * is not worth an exception to it.
 *
 * It also cannot stay in `ConnectorPanel.tsx`, which is where it started: two
 * surfaces need it now — the header's configured dot and the pattern page's
 * command panel, which has to SAY that no provider is set rather than discover
 * it by failing — and a component file that also exports a hook is the case
 * `react-refresh/only-export-components` warns about, whose own advice is
 * exactly this file.
 *
 * ONE subscriber implementation, not two. A second `useSyncExternalStore` copied
 * into the command panel would be a second answer to "is this configured?", and
 * the pair would drift the first time the store grows a field.
 */
export function useConnectorSettings(): ConnectorSettings {
  return useSyncExternalStore(
    subscribeToConnectorSettings,
    getConnectorSettings,
    getConnectorSettings,
  );
}
