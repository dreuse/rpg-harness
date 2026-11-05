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
import type { Capabilities } from './tui.ts';

const CAMPAIGN = 'streaming-speech';
const FIRST = 'The door creaks open slowly.';
const SECOND = 'Dust falls from the beams.';
const FALLBACK_WORDS = 'The AI game master is unavailable';
const TEXT_ENCODER = new TextEncoder();
const NO_CHARACTER = async () => undefined;
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
        onSegment?.(FIRST);
        await gate.promise;
        onSegment?.(SECOND);
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
        onSegment?.(FIRST);
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
        onSegment?.(FIRST);
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
        onSegment?.(FIRST);
        return reply(FIRST);
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
    assert.deepEqual(portuguese, [FIRST]);
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
        onSegment?.(FIRST);
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
        onSegment?.(FIRST);
        onSegment?.(SECOND);
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
        onSegment?.(FIRST);
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
    const { dataDir, runtime } = await setup(t);
    const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
    const text = (value: string) => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: value } });
    const provider = await startProviderServer([{ body: `${text(`${FIRST} `)}${text(SECOND)}` }]);
    t.after(provider.close);
    const gm = apiGameMaster({ ...apiRouteOf(KEY, { [GM_API_URL_ENV]: provider.url }), retryDelayMs: 0 });
    const opened = openWith(dataDir, gm, runtime);
    t.after(() => opened.close());
    submit(opened, {});
    await opened.narrate();
    await runtime.speech.idle();
    assert.equal(provider.received[0]?.body.stream, true);
    assert.equal(readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration, `${FIRST} ${SECOND}`);
    assert.ok(!FALLBACK_WORDS.includes(FIRST));
  });
});

describe('rpg-cm63.22 streamed narration for the desktop', () => {
  const streamingGm = (streams: boolean[]): GameMaster => ({
    request: async (_packet, { onSegment }) => {
      streams.push(onSegment !== undefined);
      onSegment?.(FIRST);
      onSegment?.(SECOND);
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
