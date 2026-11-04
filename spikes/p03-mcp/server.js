import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CAMPAIGNS = {
  demo: {
    campaignId: 'demo',
    revision: 0,
    scene: 'A rain-soaked crossroads inn. A hooded courier waits by the fire.',
    playerKnownFacts: ['The courier carries a sealed letter.'],
    gmSecret: 'The letter is forged.',
  },
};

function playerView({ gmSecret, ...visible }) {
  return visible;
}

const snapshotShape = {
  campaignId: z.string(),
  revision: z.number().int(),
  scene: z.string(),
  playerKnownFacts: z.array(z.string()),
};

const server = new McpServer({ name: 'rpg-harness-spike', version: '0.0.0' });

server.registerTool(
  'get_campaign_snapshot',
  {
    description: 'Read the player-visible snapshot of a campaign.',
    inputSchema: { campaignId: z.string() },
    outputSchema: snapshotShape,
    annotations: { readOnlyHint: true },
  },
  async ({ campaignId }) => {
    const campaign = CAMPAIGNS[campaignId];
    if (!campaign) {
      return { isError: true, content: [{ type: 'text', text: `Unknown campaign: ${campaignId}` }] };
    }
    const snapshot = playerView(campaign);
    return { structuredContent: snapshot, content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
  },
);

await server.connect(new StdioServerTransport());
