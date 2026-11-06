import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from './playback.ts';
import {
  changeVoiceSettings,
  routeVoiceInput,
  VOICE_SETTINGS_CHANGED,
  type VoicePreferences,
  type VoiceSession,
} from './voice-settings.ts';

const SUPPORTED_LOCALES = ['en-US', 'fr-FR', 'pt-BR'];

const preferences: VoicePreferences = {
  microphone: 'off',
  spokenOutput: 'off',
  locale: 'en-US',
  speed: 1,
};

const session = (overrides: Partial<VoiceSession> = {}): VoiceSession => ({
  campaignId: 'campaign-1',
  turn: 7,
  pendingInput: [],
  preferences,
  ...overrides,
});

describe('A14 conversational voice settings', () => {
  it('allow typed or spoken changes to mic mode, output mode, locale and speed', () => {
    const typed = changeVoiceSettings(
      session(),
      { source: 'typed', text: 'set mic to push-to-talk, output to narrator, language to fr-FR and speed 1.5' },
      SUPPORTED_LOCALES,
    );
    assert.equal(typed.ok, true);
    if (!typed.ok) return;
    assert.deepEqual(typed.session.preferences, {
      microphone: 'push-to-talk',
      spokenOutput: 'narrator',
      locale: 'fr-FR',
      speed: 1.5,
    });
    assert.equal(typed.event.type, VOICE_SETTINGS_CHANGED);
    assert.equal(typed.event.payload.source, 'typed');
    assert.deepEqual(
      typed.event.payload.changes.map(({ field, from, to }) => [field, from, to]),
      [
        ['microphone', 'off', 'push-to-talk'],
        ['spokenOutput', 'off', 'narrator'],
        ['locale', 'en-US', 'fr-FR'],
        ['speed', 1, 1.5],
      ],
    );

    const spoken = changeVoiceSettings(
      typed.session,
      { source: 'spoken', text: 'Switch to hands free and full voice, locale pt-br' },
      SUPPORTED_LOCALES,
    );
    assert.equal(spoken.ok, true);
    if (!spoken.ok) return;
    assert.equal(spoken.event.payload.source, 'spoken');
    assert.deepEqual(spoken.session.preferences, {
      microphone: 'hands-free',
      spokenOutput: 'full',
      locale: 'pt-BR',
      speed: 1.5,
    });
  });

  it('rejects unsupported locale, out-of-range speed, conflicts and no-ops with explicit reasons', () => {
    const current = session();
    const cases: [string, string, string][] = [
      ['set language to xx-YY', 'unsupported_locale', 'locale'],
      ['set language to klingon!!', 'unsupported_locale', 'locale'],
      [`set speed ${MAX_PLAYBACK_SPEED + 1}`, 'speed_out_of_range', 'speed'],
      [`set speed ${MIN_PLAYBACK_SPEED - 0.1}`, 'speed_out_of_range', 'speed'],
      ['set mic push to talk and mic hands-free', 'ambiguous', 'microphone'],
      ['turn output off', 'unchanged', ''],
      ['what is behind the door?', 'unrecognized', ''],
      ["don't turn the mic off", 'negated', 'microphone'],
      ['never use push to talk', 'negated', 'microphone'],
      ['I shout in full voice at the orc', 'unrecognized', ''],
      ['I speak the language of the elves', 'unrecognized', ''],
      ['Turn to the bard and greet him in full voice', 'unrecognized', ''],
      ['Set the orc on fire, shouting in full voice', 'unrecognized', ''],
      ['Use my mic off the table', 'unrecognized', ''],
      ['set speed to 2,5', 'speed_out_of_range', 'speed'],
      ['set speed to 1..5', 'unrecognized', ''],
      ['set speed to 1.5e3', 'unrecognized', ''],
    ];
    for (const [text, code, path] of cases) {
      const result = changeVoiceSettings(current, { source: 'typed', text }, SUPPORTED_LOCALES);
      assert.equal(result.ok, false, text);
      if (result.ok) continue;
      assert.deepEqual(result.issues, [{ code, path }], text);
    }
    assert.deepEqual(current.preferences, preferences);
  });

  it('accepts trailing punctuation, the lower speed bound and canonical duplicates', () => {
    const cases: [string, Partial<VoicePreferences>][] = [
      ['Set language to pt-BR.', { locale: 'pt-BR' }],
      [`set speed ${MIN_PLAYBACK_SPEED}`, { speed: MIN_PLAYBACK_SPEED }],
      ['set speed .5.', { speed: MIN_PLAYBACK_SPEED }],
      ['set language to fr-FR and language fr-fr', { locale: 'fr-FR' }],
      ['set speed 1.5 and speed 1.50', { speed: 1.5 }],
      ['set speed to 1,5', { speed: 1.5 }],
      ['Set mic to push to talk. I attack the orc with full voice', { microphone: 'push-to-talk' }],
      ['turn off the mic and set output narrator', { spokenOutput: 'narrator' }],
    ];
    for (const [text, expected] of cases) {
      const result = changeVoiceSettings(session(), { source: 'typed', text }, SUPPORTED_LOCALES);
      assert.equal(result.ok, true, text);
      if (!result.ok) continue;
      assert.deepEqual(result.session.preferences, { ...preferences, ...expected }, text);
    }
  });

  it('accepts Spanish and Brazilian Portuguese phrasing with or without accents', () => {
    const cases: [string, Partial<VoicePreferences>][] = [
      ['pon el micrófono en pulsar para hablar', { microphone: 'push-to-talk' }],
      ['Pon el microfono en pulsar para hablar.', { microphone: 'push-to-talk' }],
      ['cambia el micrófono a manos libres', { microphone: 'hands-free' }],
      ['pon la salida en narrador', { spokenOutput: 'narrator' }],
      ['pon la salida en cinematográfica', { spokenOutput: 'cinematic' }],
      ['pon la velocidad en 1,5', { speed: 1.5 }],
      ['pon el idioma en pt-BR', { locale: 'pt-BR' }],
      ['definir microfone para pressione para falar', { microphone: 'push-to-talk' }],
      ['definir microfone para mãos livres', { microphone: 'hands-free' }],
      ['definir saída para narrador', { spokenOutput: 'narrator' }],
      ['definir saida para cinematográfico', { spokenOutput: 'cinematic' }],
      ['definir velocidade para 1.5', { speed: 1.5 }],
      ['defina o idioma para fr-FR', { locale: 'fr-FR' }],
      ['pon el micrófono en pulsar para hablar y la velocidad en 1.5', { microphone: 'push-to-talk', speed: 1.5 }],
    ];
    for (const [text, expected] of cases) {
      const result = changeVoiceSettings(
        session({ preferences: { ...preferences, microphone: 'off', spokenOutput: 'dialogue' } }),
        { source: 'typed', text },
        SUPPORTED_LOCALES,
      );
      assert.equal(result.ok, true, text);
      if (!result.ok) continue;
      assert.deepEqual(
        result.session.preferences,
        { ...preferences, microphone: 'off', spokenOutput: 'dialogue', ...expected },
        text,
      );
    }
    const negated = changeVoiceSettings(
      session(),
      { source: 'typed', text: 'nunca pongas el micrófono en pulsar para hablar' },
      SUPPORTED_LOCALES,
    );
    assert.equal(negated.ok, false);
    const narrative = changeVoiceSettings(
      session(),
      { source: 'typed', text: 'pongo la mano en la puerta' },
      SUPPORTED_LOCALES,
    );
    assert.deepEqual(narrative, { ok: false, issues: [{ code: 'unrecognized', path: '' }] });
  });

  it('keeps locale values out of the localized word mapping', () => {
    const locales = ['en-US', 'en', 'en-GB', 'el-GR', 'pt-BR'];
    const cases: [string, string][] = [
      ['set language to en-US', 'en-US'],
      ['set language to en', 'en'],
      ['set locale to en-GB', 'en-GB'],
      ['pon el idioma en en-US', 'en-US'],
      ['pon el idioma en el-GR', 'el-GR'],
      ['definir idioma para en-GB, velocidad para 1.5', 'en-GB'],
    ];
    for (const [text, locale] of cases) {
      const result = changeVoiceSettings(
        session({ preferences: { ...preferences, locale: 'pt-BR' } }),
        { source: 'typed', text },
        locales,
      );
      assert.equal(result.ok, true, text);
      if (!result.ok) continue;
      assert.equal(result.session.preferences.locale, locale, text);
    }
  });

  it('rejects non-string requests at the boundary', () => {
    const result = changeVoiceSettings(
      session(),
      { source: 'typed', text: 42 as unknown as string },
      SUPPORTED_LOCALES,
    );
    assert.deepEqual(result, { ok: false, issues: [{ code: 'unrecognized', path: '' }] });
  });

  it('turns cinematic output on and back to full', () => {
    const on = changeVoiceSettings(session(), { source: 'typed', text: 'set output to cinematic' }, SUPPORTED_LOCALES);
    assert.equal(on.ok, true);
    if (!on.ok) return;
    assert.equal(on.session.preferences.spokenOutput, 'cinematic');
    const off = changeVoiceSettings(on.session, { source: 'typed', text: 'set output to full' }, SUPPORTED_LOCALES);
    assert.equal(off.ok, true);
    if (!off.ok) return;
    assert.equal(off.session.preferences.spokenOutput, 'full');
  });

  it('changing modes mid-session preserves campaign and input continuity', () => {
    const pendingInput = ['I open the door', 'and step inside'];
    const midSession = session({
      pendingInput,
      preferences: { ...preferences, microphone: 'hands-free', spokenOutput: 'full' },
    });
    const result = changeVoiceSettings(
      midSession,
      { source: 'spoken', text: 'settings: microphone off, output dialogue' },
      SUPPORTED_LOCALES,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.session.campaignId, midSession.campaignId);
    assert.equal(result.session.turn, midSession.turn);
    assert.deepEqual(result.session.pendingInput, pendingInput);
    assert.equal(result.event.payload.campaignId, midSession.campaignId);
    assert.equal(result.event.payload.turn, midSession.turn);
    assert.equal(result.session.preferences.microphone, 'off');
    assert.equal(result.session.preferences.spokenOutput, 'dialogue');
    assert.deepEqual(midSession.pendingInput, ['I open the door', 'and step inside']);
    assert.equal(midSession.preferences.microphone, 'hands-free');
  });
});

describe('A18 voice input routing', () => {
  it('passes unrecognized input to the GM and keeps settings commands out of play', () => {
    const submitted: string[] = [];
    const act = (text: string) => submitted.push(text);
    const gameplay = 'Turn to the bard and ask for a song.';

    const action = routeVoiceInput(session(), { source: 'spoken', text: gameplay }, SUPPORTED_LOCALES, act);
    const changed = routeVoiceInput(session(), { source: 'typed', text: 'set speed to 1.5' }, SUPPORTED_LOCALES, act);
    const rejected = routeVoiceInput(session(), { source: 'typed', text: 'set speed to 9' }, SUPPORTED_LOCALES, act);

    assert.deepEqual(action, { kind: 'action', result: 1 });
    assert.deepEqual(submitted, [gameplay]);
    assert.equal(changed.kind === 'settings' && changed.session.preferences.speed, 1.5);
    assert.deepEqual(rejected, { kind: 'settings-rejected', issues: [{ code: 'speed_out_of_range', path: 'speed' }] });
  });

  it('sends text after the first sentence of a settings line to the GM', () => {
    const submitted: string[] = [];
    const act = (text: string) => submitted.push(text);
    const text = 'Set mic to push to talk. I attack the orc! Then I run.';
    const changed = routeVoiceInput(session(), { source: 'typed', text }, SUPPORTED_LOCALES, act);
    const rejected = routeVoiceInput(
      session(),
      { source: 'typed', text: 'set speed 9. I wait.' },
      SUPPORTED_LOCALES,
      act,
    );
    const single = routeVoiceInput(session(), { source: 'typed', text: 'Set speed 1.5.' }, SUPPORTED_LOCALES, act);

    assert.equal(changed.kind === 'settings' && changed.session.preferences.microphone, 'push-to-talk');
    assert.equal(changed.kind === 'settings' && changed.action, 1);
    assert.equal(rejected.kind === 'settings-rejected' && rejected.action, 2);
    assert.equal(single.kind === 'settings' && single.action, undefined);
    assert.deepEqual(submitted, ['I attack the orc! Then I run.', 'I wait.']);
  });
});
