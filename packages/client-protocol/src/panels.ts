import type { CampaignId } from '../../domain/src/campaign.ts';
import { type CampaignPanels, type ClientSession, PROTOCOL_VERSION, type Unsubscribe } from './protocol.ts';

export type { CampaignPanels } from './protocol.ts';

const NO_SUBSCRIPTION = () => {};

export const watchPanels = (
  session: ClientSession,
  campaignId: CampaignId,
  listener: (panels: CampaignPanels) => void,
): Unsubscribe => {
  const read = () => session.getPanels({ version: PROTOCOL_VERSION, type: 'GetCampaignPanels', campaignId });
  const first = read();
  if (!first.ok) return NO_SUBSCRIPTION;
  listener(first.value);
  return session.subscribeEvents(
    { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId, fromRevision: first.value.revision },
    () => {
      const panels = read();
      if (panels.ok) listener(panels.value);
    },
  );
};
