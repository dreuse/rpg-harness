import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION, type SavedVoiceSettings } from '../../../packages/client-protocol/src/protocol.ts';
import { type ContextPacket, packetParts } from '../../../packages/memory/src/packet.ts';
import { startProviderServer } from '../../../packages/testkit/src/provider-server.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import {
  apiGameMaster,
  createCampaignFrom,
  createEngineGateway,
  disposeSpeech,
  FAKE_GAME_MASTER,
  type GameMaster,
  liveSpeech,
  openClientSession,
  playbackFor,
  readCampaignState,
} from './engine-gateway.ts';
import { apiRouteOf, GM_API_URL_ENV, languageInstruction, ProviderError } from './gm-api.ts';
import type { GmSegment } from './gm-segments.ts';
import { createSpeechRuntime } from './speech-runtime.ts';
import { type Capabilities, PLAIN_TERMINAL } from './tui.ts';

const CAMPAIGN = 'streaming-speech';
const FIRST = 'The door creaks open slowly.';
const SECOND = 'Dust falls from the beams.';
const FALLBACK_WORDS = 'The AI game master is unavailable';
const TEXT_ENCODER = new TextEncoder();
const NO_CHARACTER = async () => undefined;
const TUI_QUIT = 'q';
const SPEECH_WAIT_ROUNDS = 2000;
const KEY = 'sk-ant-streaming-key';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let round = 0; round < 8; round += 1) await tick();
};

const kokoro = (spoken: string[], id = 'kokoro'): TtsProvider => ({
  id,
  locality: 'local',
  retention: 'none',
  healthy: () => true,
  async *synthesize(utterance, voiceId): AsyncGenerator<SpeechChunk> {
    yield {
      utteranceEventId: utterance.eventId,
      sequence: 0,
      audio: TEXT_ENCODER.encode(`${utterance.speakerId}|${utterance.text}`),
      mimeType: 'audio/wav',
      voiceId,
      final: true,
    };
    spoken.push(utterance.text);
  },
});

const setup = async (t: TestContext, providers: readonly TtsProvider[] = [kokoro([])], language?: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-stream-speech-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER, undefined, language));
  const played: string[] = [];
  const blocked = { current: false, release: () => {} };
  const runtime = createSpeechRuntime({
    providers,
    route: 'mlx',
    sink: {
      play: async (chunk, _speed, signal) => {
        played.push(new TextDecoder().decode(chunk.audio));
        if (!blocked.current) return;
        await new Promise<void>((resolve) => {
          blocked.release = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  });
  return { dataDir, played, blocked, runtime };
};

const openWith = (dataDir: string, gm: GameMaster, runtime: ReturnType<typeof createSpeechRuntime>) =>
  openClientSession(dataDir, CAMPAIGN, gm, Math.random, () => runtime);

const submit = (
  opened: ReturnType<typeof openClientSession>,
  voice: Partial<SavedVoiceSettings> | undefined,
  actionId = 'typed-1',
) => {
  const { session, campaignId } = opened;
  const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(snapshot.ok);
  if (voice !== undefined) {
    const saved = session.saveVoiceSettings({
      version: PROTOCOL_VERSION,
      type: 'SaveVoiceSettings',
      campaignId,
      actionId: 'voice-1',
      expectedRevision: snapshot.value.revision,
      microphone: 'off',
      spokenOutput: 'full',
      locale: 'en',
      speed: 1,
      ...voice,
    });
    assert.ok(saved.ok);
  }
  const latest = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(latest.ok);
  const action = session.submitPlayerAction({
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId,
    actionId,
    expectedRevision: latest.value.revision,
    sceneId: latest.value.currentScene?.id ?? '',
    actorId: latest.value.characters[0]?.id ?? '',
    input: 'I look around',
  });
  assert.ok(action.ok);
};

const reply = (narration: string, segments: readonly GmSegment[] = [{ text: narration }]) => ({ narration, segments });

describe('rpg-cm63.17 streaming speech in the GM turn flow', () => {
  it('speaks the first sentence before the reply ends and the rest as it streams', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gate = Promise.withResolvers<void>();
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        await gate.promise;
        onSegment?.({ text: SECOND });
        return reply(`${FIRST} ${SECOND}`);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    const narrating = opened.narrate();
    await settle();
    assert.deepEqual(played, [`narrator|${FIRST}`]);
    gate.resolve();
    await narrating;
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${FIRST}`, `narrator|${SECOND}`]);
    assert.equal(readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration, `${FIRST} ${SECOND}`);
  });

  it('speaks the streamed narration with the pt-BR MLX voice', async (t) => {
    const { dataDir, played, runtime } = await setup(t, [kokoro([]), kokoro([], 'kokoro-mlx')]);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        return reply(FIRST);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { locale: 'pt-BR' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${FIRST}`]);
  });

  it('speaks a pt-BR campaign with the pt-BR voice when the saved locale is English', async (t) => {
    const english: string[] = [];
    const portuguese: string[] = [];
    const { dataDir, runtime } = await setup(t, [kokoro(english), kokoro(portuguese, 'kokoro-mlx')], 'pt-BR');
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        return reply(FIRST);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { locale: 'en' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(english, []);
    assert.deepEqual(portuguese, [FIRST]);
  });

  it('rpg-42a.67: the turn after SetCampaignLanguage is narrated and spoken in the new language', async (t) => {
    const english: string[] = [];
    const portuguese: string[] = [];
    const { dataDir, runtime } = await setup(t, [kokoro(english), kokoro(portuguese, 'kokoro-mlx')], 'en');
    const instructions: string[] = [];
    const gm: GameMaster = {
      request: async (packet: ContextPacket, { onSegment }) => {
        instructions.push(packetParts(packet).instructions);
        const text = instructions.length === 1 ? FIRST : SECOND;
        onSegment?.({ text });
        return reply(text);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { locale: 'en' });
    await opened.narrate();
    await runtime.speech.idle();
    const { session, campaignId } = opened;
    const before = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
    assert.ok(before.ok);
    const changed = session.setCampaignLanguage({
      version: PROTOCOL_VERSION,
      type: 'SetCampaignLanguage',
      campaignId,
      actionId: 'language-1',
      expectedRevision: before.value.revision,
      language: 'pt-BR',
    });
    assert.ok(changed.ok);
    const after = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
    assert.ok(after.ok);
    assert.equal(after.value.language, 'pt-BR');
    const action = session.submitPlayerAction({
      version: PROTOCOL_VERSION,
      type: 'SubmitPlayerAction',
      campaignId,
      actionId: 'typed-2',
      expectedRevision: after.value.revision,
      sceneId: after.value.currentScene?.id ?? '',
      actorId: after.value.characters[0]?.id ?? '',
      input: 'I look again',
    });
    assert.ok(action.ok);
    await opened.narrate();
    await runtime.speech.idle();
    assert.ok(instructions[0]?.endsWith(languageInstruction('en')));
    assert.ok(instructions[1]?.endsWith(languageInstruction('pt-BR')));
    assert.deepEqual(english, [FIRST]);
    assert.deepEqual(portuguese, [SECOND]);
  });

  it('preloads the pt-BR voice when a spoken turn starts', async (t) => {
    const preloads: string[] = [];
    const mlx = { ...kokoro([], 'kokoro-mlx'), preload: async () => void preloads.push('mlx') };
    const { dataDir, runtime } = await setup(t, [kokoro([]), mlx], 'pt-BR');
    const gm: GameMaster = { request: async () => reply(FIRST), summarizer: FAKE_GAME_MASTER.summarizer };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { locale: 'pt-BR' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(preloads, ['mlx']);
  });

  it('tells the player once, mid-session, that the pt-BR voice failed to load', async (t) => {
    const mlx = { ...kokoro([], 'kokoro-mlx'), preload: () => Promise.reject(new Error('broken install')) };
    const { dataDir, played, runtime } = await setup(t, [kokoro([]), mlx], 'pt-BR');
    const gm: GameMaster = { request: async () => reply(FIRST), summarizer: FAKE_GAME_MASTER.summarizer };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    const narrations: string[] = [];
    for (const turn of [1, 2, 3]) {
      submit(opened, turn === 1 ? { locale: 'pt-BR' } : undefined, `typed-${turn}`);
      await opened.narrate();
      await runtime.speech.idle();
      await settle();
      narrations.push(readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration ?? '');
    }
    assert.equal(narrations[0], FIRST);
    assert.match(narrations[1] ?? '', /^Brazilian Portuguese voices are not available on this computer\./);
    assert.equal(narrations[2], FIRST);
    assert.ok(played.every((text) => !text.includes('not available')));
  });

  it('reports speech metrics to the voice diagnostics without narration text', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        return reply(FIRST);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    const summary = runtime.diagnostics.summary();
    assert.equal(summary.samples, 1);
    assert.ok(!JSON.stringify(summary).includes('door'));
  });

  it('keeps the model call non-streaming when spoken output is off', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const streams: boolean[] = [];
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        streams.push(onSegment !== undefined);
        return reply(FIRST);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, undefined);
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(streams, [false]);
    assert.deepEqual(played, []);
  });

  it('rpg-cm63.36: speaks a streamed NPC segment with the NPC voice and the narrator segment with the narrator voice', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        onSegment?.({ speakerId: 'old-tam', text: 'Sit down, stranger.' });
        return reply(`${FIRST} Sit down, stranger.`, [
          { text: FIRST },
          { speakerId: 'old-tam', text: 'Sit down, stranger.' },
        ]);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${FIRST}`, 'old-tam|Sit down, stranger.']);
    assert.equal(readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration, `${FIRST} Sit down, stranger.`);
  });

  it('uses the tagged non-streaming reply in dialogue mode and speaks only the dialogue', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const streams: boolean[] = [];
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        streams.push(onSegment !== undefined);
        return reply(`${FIRST} Sit.`, [{ text: FIRST }, { speakerId: 'npc-stranger', text: 'Sit.' }]);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'dialogue' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(streams, [false]);
    assert.deepEqual(played, ['npc-stranger|Sit.']);
  });

  it('speaks a non-streamed reply once it is recorded', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gm: GameMaster = { request: async () => reply(FIRST), summarizer: FAKE_GAME_MASTER.summarizer };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${FIRST}`]);
  });

  it('discards queued audio when the stream is replaced by the fallback narration', async (t) => {
    const { dataDir, played, blocked, runtime } = await setup(t);
    blocked.current = true;
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        onSegment?.({ text: SECOND });
        await settle();
        throw new ProviderError('stream broke');
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await assert.rejects(opened.narrate(), ProviderError);
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${FIRST}`]);
    assert.equal(runtime.speech.depth(), 0);
  });

  it('drops segments of a turn that was already rejected', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        runtime.speech.stop();
        onSegment?.({ text: FIRST });
        return reply(FIRST);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(played, []);
  });

  it('the api route streams with stream:true only when the turn speaks', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
    const toolStart = sse({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'narrate', input: {} },
    });
    const input = (value: string) =>
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: value } });
    const segments = JSON.stringify({ segments: [{ text: FIRST }, { speakerId: 'old-tam', text: SECOND }] });
    const provider = await startProviderServer([{ body: `${toolStart}${input(segments)}` }]);
    t.after(provider.close);
    const gm = apiGameMaster({ ...apiRouteOf(KEY, { [GM_API_URL_ENV]: provider.url }), retryDelayMs: 0 });
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    assert.equal(provider.received[0]?.body.stream, true);
    assert.deepEqual(played, [`narrator|${FIRST}`, `old-tam|${SECOND}`]);
    assert.equal(readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration, `${FIRST} ${SECOND}`);
    assert.ok(!FALLBACK_WORDS.includes(FIRST));
  });
});

describe('rpg-cm63.22 streamed narration for the desktop', () => {
  const streamingGm = (streams: boolean[]): GameMaster => ({
    request: async (_packet, { onSegment }) => {
      streams.push(onSegment !== undefined);
      onSegment?.({ text: FIRST });
      onSegment?.({ text: SECOND });
      return reply(`${FIRST} ${SECOND}`);
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  });

  it('hands each streamed segment with the turn id to the listener while the turn streams for speech', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const streams: boolean[] = [];
    const opened = openWith(dataDir, streamingGm(streams), runtime);
    t.after(() => opened.close());
    submit(opened, {});
    const heard: (readonly [string, string])[] = [];
    await opened.narrate((turnId, segment) => heard.push([turnId, segment]));
    const turnId = readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.id ?? '';
    assert.notEqual(turnId, '');
    assert.deepEqual(streams, [true]);
    assert.deepEqual(heard, [
      [turnId, FIRST],
      [turnId, SECOND],
    ]);
  });

  it('keeps the model call non-streaming while spoken output is off even with a listener', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const streams: boolean[] = [];
    const opened = openWith(dataDir, streamingGm(streams), runtime);
    t.after(() => opened.close());
    submit(opened, undefined);
    const heard: string[] = [];
    await opened.narrate((_turnId, segment) => heard.push(segment));
    assert.deepEqual(streams, [false]);
    assert.deepEqual(heard, []);
  });

  it('still speaks the streamed segments when a listener is attached', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const opened = openWith(dataDir, streamingGm([]), runtime);
    t.after(() => opened.close());
    submit(opened, {});
    const heard: string[] = [];
    await opened.narrate((_turnId, segment) => heard.push(segment));
    await runtime.speech.idle();
    assert.deepEqual(heard, [FIRST, SECOND]);
    assert.deepEqual(played, [`narrator|${FIRST}`, `narrator|${SECOND}`]);
  });

  it('keeps the tagged non-streaming call in dialogue mode even with a listener', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const streams: boolean[] = [];
    const opened = openWith(dataDir, streamingGm(streams), runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'dialogue' });
    const heard: string[] = [];
    await opened.narrate((_turnId, segment) => heard.push(segment));
    assert.deepEqual(streams, [false]);
    assert.deepEqual(heard, []);
  });
});

describe('rpg-cm63.17 speech runtime lifetime', () => {
  const PLAIN: Capabilities = { width: 80, height: 24, colors: 'none', unicode: false, interactive: false };
  const disposing = (runtime: ReturnType<typeof createSpeechRuntime>, calls: string[]) => ({
    ...runtime,
    dispose: () => {
      calls.push('dispose');
      runtime.dispose();
    },
  });

  it('disposes the live runtime and forgets it when the TUI exits', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const calls: string[] = [];
    const fake = disposing(runtime, calls);
    await liveSpeech(dataDir, () => fake)();
    assert.ok(playbackFor(dataDir).diagnostics?.() !== undefined);
    const terminal = { capabilities: PLAIN, lines: (async function* () {})(), write: () => {} };
    await createEngineGateway(dataDir, FAKE_GAME_MASTER, Math.random, () => fake).tui(CAMPAIGN, terminal);
    assert.deepEqual(calls, ['dispose']);
    assert.equal(playbackFor(dataDir).diagnostics?.(), undefined);
  });

  it('disposeSpeech disposes once and is harmless without a runtime', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const calls: string[] = [];
    const fake = disposing(runtime, calls);
    disposeSpeech(dataDir);
    await liveSpeech(dataDir, () => fake)();
    disposeSpeech(dataDir);
    disposeSpeech(dataDir);
    assert.deepEqual(calls, ['dispose']);
  });

  it('shows the player a notice when the campaign language has no usable voice', async (t) => {
    const { dataDir, runtime } = await setup(t);
    const opened = openWith(dataDir, FAKE_GAME_MASTER, runtime);
    submit(opened, { locale: 'pt-BR' });
    await opened.settle();
    opened.close();
    const written: string[] = [];
    const terminal = {
      capabilities: PLAIN,
      lines: (async function* () {})(),
      write: (text: string) => void written.push(text),
    };
    await createEngineGateway(dataDir, FAKE_GAME_MASTER, Math.random, () => runtime).tui(CAMPAIGN, terminal);
    assert.match(written.join(''), /not available on this computer/);
  });
});

describe('rpg-42a.98 every paragraph is read, retried attempts restart, failures tell the player', () => {
  const NPC_ONE = { speakerId: 'marta-vale', text: 'Stay close to the wall, friend.' };
  const NPC_TWO = { speakerId: 'viajante-ferido', text: 'Please, I cannot walk any further.' };
  const CLOSING = { text: 'The wind carries their voices away.' };
  const OWNER_TURN: readonly GmSegment[] = [{ text: FIRST }, NPC_ONE, NPC_TWO, CLOSING];
  const narrationOf = (segments: readonly GmSegment[]) => segments.map(({ text }) => text).join('\n\n');

  const streaming = (segments: readonly GmSegment[]): GameMaster => ({
    request: async (_packet, { onSegment }) => {
      for (const segment of segments) onSegment?.(segment);
      return reply(narrationOf(segments), segments);
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  });

  it('replays the owner turn in narrator mode and logs every paragraph in order in the narrator voice', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const opened = openWith(dataDir, streaming(OWNER_TURN), runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'narrator' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(
      played,
      OWNER_TURN.map(({ text }) => `narrator|${text}`),
    );
  });

  it('keeps the speaker tags of NPC lines in full mode', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const opened = openWith(dataDir, streaming(OWNER_TURN), runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'full' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(played, [
      `narrator|${FIRST}`,
      `marta-vale|${NPC_ONE.text}`,
      `viajante-ferido|${NPC_TWO.text}`,
      `narrator|${CLOSING.text}`,
    ]);
  });

  it('a resent attempt stops the first attempt audio before the second one streams', async (t) => {
    const { dataDir, played, blocked, runtime } = await setup(t);
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        calls += 1;
        if (calls === 1) {
          onSegment?.({ text: FIRST });
          await settle();
          throw new ProviderError('too long', 400, true);
        }
        onSegment?.({ text: SECOND });
        await gate.promise;
        return reply(SECOND);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'narrator' });
    blocked.current = true;
    const narrating = opened.narrate();
    await settle();
    await settle();
    assert.deepEqual(played, [`narrator|${FIRST}`, `narrator|${SECOND}`]);
    gate.resolve();
    await narrating;
    blocked.release();
    await runtime.speech.idle();
    assert.equal(calls, 2);
    assert.deepEqual(played, [`narrator|${FIRST}`, `narrator|${SECOND}`]);
  });

  it('speaks the final paragraphs that were not streamed instead of dropping the turn', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        return reply(narrationOf(OWNER_TURN), OWNER_TURN);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'narrator' });
    await opened.narrate();
    await runtime.speech.idle();
    assert.deepEqual(
      played,
      OWNER_TURN.map(({ text }) => `narrator|${text}`),
    );
  });

  it('speaks the recorded narration when it differs from what streamed', async (t) => {
    const { dataDir, played, runtime } = await setup(t);
    const gm: GameMaster = {
      request: async (_packet, { onSegment }) => {
        onSegment?.({ text: FIRST });
        return reply(SECOND);
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'narrator' });
    runtime.speech.pause();
    await opened.narrate();
    runtime.speech.resume();
    await runtime.speech.idle();
    assert.deepEqual(played, [`narrator|${SECOND}`]);
  });

  it('tells the player in the next turn when a line could not be read aloud', async (t) => {
    const failing: TtsProvider = {
      ...kokoro([]),
      async *synthesize() {
        yield await Promise.reject(new Error(KEY));
      },
    };
    const { dataDir, runtime } = await setup(t, [failing]);
    const opened = openWith(dataDir, streaming([{ text: FIRST }]), runtime);
    t.after(() => opened.close());
    submit(opened, { spokenOutput: 'narrator' });
    await opened.narrate();
    await runtime.speech.idle();
    submit(opened, undefined, 'typed-2');
    await opened.narrate();
    await runtime.speech.idle();
    const narration = readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration ?? '';
    assert.match(narration, /could not be read aloud/);
    assert.ok(!narration.includes(KEY));
  });
});

describe('rpg-42a.62 spoken narration follows the continuity-corrected text', () => {
  const MARA = { kind: 'entity', id: 'mara', entityKind: 'npc', name: 'Mara', visibility: 'player' } as const;
  const DEAD = { kind: 'claim', id: 'mara-dead', entityId: 'mara', claimKind: 'alive', value: 'dead' } as const;
  const SECRET = {
    kind: 'claim',
    id: 'mara-plot',
    entityId: 'mara',
    claimKind: 'secret',
    key: 'plot',
    value: 'poisoned the well',
  } as const;
  const LEAK = 'Everyone knows Mara poisoned the well.';
  const WAKES = 'Mara says hello to you.';

  const spokenAfter = async (t: TestContext, narration: string) => {
    const { dataDir, played, runtime } = await setup(t);
    const replies = [{ narration: FIRST, proposals: [MARA, DEAD, SECRET] }, { narration }];
    let calls = 0;
    const gm: GameMaster = {
      request: async () => {
        const next = replies[Math.min(calls, replies.length - 1)] ?? { narration: '' };
        calls += 1;
        return { ...next, segments: [{ text: next.narration }] };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    played.length = 0;
    submit(opened, undefined, 'typed-2');
    await opened.narrate();
    await runtime.speech.idle();
    return played.join(' ');
  };

  it('never speaks a GM-only secret', async (t) => {
    assert.ok(!(await spokenAfter(t, LEAK)).includes('poisoned'));
  });

  it('never speaks a contradiction that survives the retry', async (t) => {
    assert.ok(!(await spokenAfter(t, WAKES)).includes(WAKES));
  });
});

describe('rpg-cm63.67 opening scene speech', () => {
  const create = async (t: TestContext, spokenOutput?: 'full') => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rpg-opening-speech-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    await createCampaignFrom(dataDir, {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: CAMPAIGN,
      ...(spokenOutput === undefined ? {} : { play: { spokenOutput } }),
    });
    const played: string[] = [];
    const runtime = createSpeechRuntime({
      providers: [kokoro([])],
      route: 'mlx',
      sink: { play: async (chunk) => void played.push(new TextDecoder().decode(chunk.audio)) },
    });
    const opened = openClientSession(dataDir, CAMPAIGN, FAKE_GAME_MASTER, Math.random, () => runtime);
    const snapshot = opened.session.getSnapshot({
      version: PROTOCOL_VERSION,
      type: 'GetCampaignSnapshot',
      campaignId: opened.campaignId,
    });
    assert.ok(snapshot.ok);
    return { opened, played, runtime, dataDir, narration: snapshot.value.turns[0]?.narration ?? '' };
  };

  it('speaks the opening narration of a new adventure when voice is on', async (t) => {
    const { opened, played, narration } = await create(t, 'full');
    assert.notEqual(narration, '');
    await opened.speakOpening();
    await settle();
    assert.ok(
      played.some((line) => line.includes(narration)),
      played.join('\n'),
    );
  });

  it('stays silent for the opening when voice is off', async (t) => {
    const { opened, played } = await create(t);
    await opened.speakOpening();
    await settle();
    assert.deepEqual(played, []);
  });

  const playInTui = async (t: TestContext, spokenOutput: 'full' | undefined) => {
    const { played, runtime, dataDir } = await create(t, spokenOutput);
    const quit = (async function* () {
      for (let round = 0; round < SPEECH_WAIT_ROUNDS && spokenOutput !== undefined && played.length === 0; round += 1)
        await tick();
      yield TUI_QUIT;
    })();
    await createEngineGateway(dataDir, FAKE_GAME_MASTER, Math.random, () => runtime).tui(CAMPAIGN, {
      capabilities: PLAIN_TERMINAL,
      lines: quit,
      write: () => undefined,
    });
    await settle();
    return played;
  };

  it('speaks the opening in the terminal when voice is on', async (t) => {
    const played = await playInTui(t, 'full');
    assert.ok(played.length > 0);
  });

  it('keeps the terminal opening silent when voice is off', async (t) => {
    assert.deepEqual(await playInTui(t, undefined), []);
  });
});
