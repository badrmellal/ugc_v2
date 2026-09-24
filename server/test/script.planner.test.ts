import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { TextModelClient } from '../src/core/ports.js';
import { MockTextClient, mockSplitAnswer } from '../src/gemini/mock.js';
import { fallbackPlan } from '../src/script/fallback.js';
import {
  buildSplitPrompt,
  createPlanner,
  DefaultScriptPlanner,
  PLAN_JSON_SCHEMA,
  SPLIT_SYSTEM_INSTRUCTION,
} from '../src/script/planner.js';
import { actionSentence, buildPart1Prompt, buildPart2Prompt } from '../src/script/prompts.js';
import { DEFAULT_SETTINGS, type GenerationSettings, type ScriptPlan } from '../src/shared/api.js';

const EM_DASH = String.fromCharCode(0x2014);
const logger = pino({ level: 'silent' });
const config = loadConfig({ NODE_ENV: 'test', GEMINI_MOCK: 'true' });
const settings = (over: Partial<GenerationSettings> = {}): GenerationSettings => ({ ...DEFAULT_SETTINGS, ...over });

const SCRIPT =
  'I was today years old when I learned that your phone screen has more bacteria than a toilet seat. ' +
  'Wipe it down once a day with an alcohol wipe, especially before bed. ' +
  'Your skin will thank you, and so will your pillowcase.';

function planner(text: TextModelClient | null, timeoutMs?: number) {
  return new DefaultScriptPlanner(text, config, logger, { timeoutMs });
}

describe('DefaultScriptPlanner.split', () => {
  it('uses the text model answer when it keeps the script verbatim', async () => {
    const text = new MockTextClient({ config });
    const result = await planner(text).split({ script: SCRIPT, settings: settings() });
    expect(result.plan.source).toBe('llm');
    expect(result.model).toBe(config.gemini.splitterModel);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(0.05);
    const [a, b] = result.plan.segments;
    expect(`${a.dialogue} ${b.dialogue}`).toBe(SCRIPT);
    expect(a.prompt).toContain(`says, with natural lip sync: "${a.dialogue}"`);
    expect(b.prompt.startsWith('Extend this video.')).toBe(true);
  });

  it('sends the system instruction, the schema and the script between markers', async () => {
    let seen: Parameters<TextModelClient['generateJson']>[0] | null = null;
    const text = new MockTextClient({
      respond: (input) => {
        seen = input;
        return mockSplitAnswer(input.prompt);
      },
    });
    await planner(text).split({ script: SCRIPT, settings: settings({ style: 'scientific', language: 'fr' }) });
    expect(seen).not.toBeNull();
    const input = seen as unknown as Parameters<TextModelClient['generateJson']>[0];
    expect(input.systemInstruction).toBe(SPLIT_SYSTEM_INSTRUCTION);
    expect(input.jsonSchema).toBe(PLAN_JSON_SCHEMA);
    expect(input.timeoutMs).toBeGreaterThan(0);
    expect(input.prompt).toContain('Style: scientific.');
    expect(input.prompt).toContain('Spoken language: French (fr)');
    expect(input.prompt).toContain(`<<<SCRIPT\n${SCRIPT}\nSCRIPT>>>`);
  });

  it('falls back when the model returns invalid JSON, and still reports the billed call', async () => {
    const text = new MockTextClient({ config, respond: () => ({ foo: 'bar' }) });
    const result = await planner(text).split({ script: SCRIPT, settings: settings() });
    expect(result.plan.source).toBe('fallback');
    expect(result.model).toBe(config.gemini.splitterModel);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(`${result.plan.segments[0].dialogue} ${result.plan.segments[1].dialogue}`).toBe(SCRIPT);
  });

  it('falls back when the model drops words', async () => {
    const text = new MockTextClient({
      respond: (input) => {
        const answer = mockSplitAnswer(input.prompt) as { part2: { dialogue: string } };
        answer.part2.dialogue = 'Your skin will thank you.';
        return answer;
      },
    });
    const result = await planner(text).split({ script: SCRIPT, settings: settings() });
    expect(result.plan.source).toBe('fallback');
    expect(result.plan.segments[1].dialogue).toContain('pillowcase');
  });

  it('falls back when the model invents claims', async () => {
    const text = new MockTextClient({
      respond: (input) => {
        const answer = mockSplitAnswer(input.prompt) as { part1: { dialogue: string } };
        answer.part1.dialogue += ' Studies prove it cures acne in three days.';
        return answer;
      },
    });
    const result = await planner(text).split({ script: SCRIPT, settings: settings() });
    expect(result.plan.source).toBe('fallback');
    expect(JSON.stringify(result.plan)).not.toContain('cures acne');
  });

  it('falls back when the model puts everything in one part', async () => {
    const text = new MockTextClient({
      respond: (input) => {
        const answer = mockSplitAnswer(input.prompt) as { part1: { dialogue: string }; part2: { dialogue: string } };
        answer.part1.dialogue = `${answer.part1.dialogue} ${answer.part2.dialogue}`;
        answer.part2.dialogue = '';
        return answer;
      },
    });
    expect((await planner(text).split({ script: SCRIPT, settings: settings() })).plan.source).toBe('fallback');
  });

  it('tolerates tiny harmless differences such as a dropped speaker label', async () => {
    const script = `Hook: ${SCRIPT}`;
    const text = new MockTextClient({
      respond: (input) => {
        const answer = mockSplitAnswer(input.prompt) as { part1: { dialogue: string } };
        answer.part1.dialogue = `Hook: ${answer.part1.dialogue}`;
        return answer;
      },
    });
    expect((await planner(text).split({ script, settings: settings() })).plan.source).toBe('llm');
  });

  it('falls back on transport errors and timeouts without reporting a cost', async () => {
    const failing: TextModelClient = {
      model: 'gemini-test',
      generateJson: async () => {
        throw new Error('503 The model is overloaded');
      },
    };
    const r1 = await planner(failing).split({ script: SCRIPT, settings: settings() });
    expect(r1).toMatchObject({ usage: null, costUsd: 0, model: null });
    expect(r1.plan.source).toBe('fallback');

    const slow = new MockTextClient({ delayMs: 500 });
    const started = Date.now();
    const r2 = await planner(slow, 50).split({ script: SCRIPT, settings: settings() });
    expect(r2.plan.source).toBe('fallback');
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('uses the fallback directly without a text model', async () => {
    const result = await createPlanner(config, null, logger).split({ script: SCRIPT, settings: settings() });
    expect(result).toMatchObject({ usage: null, costUsd: 0, model: null });
    expect(result.plan.source).toBe('fallback');
  });

  it('keeps non-pacing model warnings but recomputes pacing warnings', async () => {
    const text = new MockTextClient({
      respond: (input) => ({
        ...mockSplitAnswer(input.prompt),
        warnings: ['The script is too long for 20 seconds.', 'The script mentions a brand name.'],
      }),
    });
    const { plan } = await planner(text).split({ script: SCRIPT, settings: settings() });
    expect(plan.warnings).toContain('The script mentions a brand name.');
    expect(plan.warnings).not.toContain('The script is too long for 20 seconds.');
  });
});

describe('DefaultScriptPlanner.finalize and prompts', () => {
  const p = planner(null);
  const base = (over: Partial<GenerationSettings> = {}) => fallbackPlan(SCRIPT, settings(over));

  it('binds the image with <IMAGE_REF_0> in reference mode', () => {
    const plan = base();
    expect(plan.segments[0].prompt).toContain('the person in <IMAGE_REF_0>');
    expect(plan.segments[0].prompt).not.toContain('<FIRST_FRAME>');
    expect(plan.segments[0].prompt).toMatch(/single|one continuous, unbroken/);
    expect(plan.segments[0].prompt).toContain('no scene cuts');
    expect(plan.segments[1].prompt.startsWith('Extend this video.')).toBe(true);
    expect(plan.segments[1].prompt).not.toContain('<IMAGE_REF_0>');
  });

  it('starts part 1 with <FIRST_FRAME> in first_frame mode', () => {
    const plan = base({ imageMode: 'first_frame' });
    expect(plan.segments[0].prompt.startsWith('<FIRST_FRAME>')).toBe(true);
    expect(plan.segments[0].prompt).not.toContain('<IMAGE_REF_0>');
  });

  it('adds the <IMAGE_REF_0> reference sentence to part 2 when reinforcing the character', () => {
    const plan = base({ reinforceCharacterOnExtend: true });
    expect(plan.segments[1].prompt).toContain('same person shown in <IMAGE_REF_0>');
    expect(plan.segments[1].prompt.startsWith('Extend this video.')).toBe(true);
  });

  it('repeats the continuity bible verbatim in both prompts and keeps speech inside SPEECH_WINDOWS', () => {
    const plan = base();
    for (const field of [plan.character, plan.setting, plan.voice, plan.audio]) {
      const needle = field.replace(/[.]$/, '');
      expect(plan.segments[0].prompt).toContain(needle);
      expect(plan.segments[1].prompt).toContain(needle);
    }
    // Part 1 speaks 0.5-8s and part 2 0.8-8.5s, leaving about 2s of silence around the seam.
    expect(plan.segments[0].prompt).toContain('[0.5-8s]');
    expect(plan.segments[0].prompt).toContain('[8-10s]');
    expect(plan.segments[1].prompt).toContain('[0-0.8s]');
    expect(plan.segments[1].prompt).toContain('[0.8-8.5s]');
    // Captions are burned in afterwards (default on), so the model is told to draw no text of its own.
    expect(plan.segments[0].prompt).toContain('No text or subtitles on screen.');
    expect(plan.segments[0].prompt).toContain('No background music.');
    expect(plan.segments[0].prompt.length).toBeLessThan(1300);
    expect(plan.segments[1].prompt.length).toBeLessThan(1300);
  });

  it('rebuilds prompts from user edits, strips tags and never contains U+2014', () => {
    const plan = base();
    const edited: ScriptPlan = {
      ...plan,
      source: 'user',
      audio: 'soft lo-fi background music and quiet room tone',
      segments: [
        { ...plan.segments[0], dialogue: `New opening line${EM_DASH}with a pause. <FIRST_FRAME>`, prompt: 'stale' },
        { ...plan.segments[1], onScreenText: 'Clean your phone', prompt: 'stale' },
      ],
      warnings: ['Script needs about 99s to speak; stale warning', 'Keep the logo visible.'],
    };
    const out = p.finalize(edited, settings({ style: 'scientific', language: 'fr', reinforceCharacterOnExtend: true }));
    expect(out.source).toBe('user');
    expect(out.language).toBe('fr');
    expect(out.segments[0].dialogue).toBe('New opening line, with a pause.');
    expect(out.segments[0].prompt).toContain('says, with natural lip sync: "New opening line, with a pause."');
    expect(out.segments[0].prompt).not.toContain('<FIRST_FRAME>');
    expect(out.segments[0].prompt).toContain('The presenter speaks French.');
    expect(out.segments[1].prompt).toContain('The presenter speaks French.');
    expect(out.segments[1].prompt).toContain('reading "Clean your phone"');
    expect(out.segments[1].prompt).not.toContain('No background music.');
    expect(out.warnings).toContain('Keep the logo visible.');
    expect(out.warnings.some((w) => w.includes('stale'))).toBe(false);
    expect(out.warnings.some((w) => w.includes('French'))).toBe(true);
    expect(JSON.stringify(out)).not.toContain(EM_DASH);
    // Idempotent: finalizing twice gives the same plan.
    expect(
      p.finalize(out, settings({ style: 'scientific', language: 'fr', reinforceCharacterOnExtend: true })),
    ).toEqual(out);
  });

  it('fills missing fields with style defaults and caps field lengths', () => {
    const out = p.finalize(
      {
        source: 'user',
        character: '',
        setting: 'x'.repeat(5000),
        voice: '',
        audio: '',
        language: 'en',
        segments: [
          {
            index: 1,
            startSec: 0,
            endSec: 10,
            dialogue: 'Hello there.',
            action: '',
            camera: '',
            onScreenText: '',
            prompt: '',
          },
          {
            index: 2,
            startSec: 10,
            endSec: 20,
            dialogue: 'Bye now.',
            action: '',
            camera: '',
            onScreenText: '',
            prompt: '',
          },
        ],
        warnings: [],
        estimatedSpokenSeconds: 0,
      },
      settings({ voiceHint: 'bright, playful voice' }),
    );
    expect(out.character.length).toBeGreaterThan(10);
    expect(out.setting.length).toBeLessThanOrEqual(300);
    expect(out.voice).toBe('bright, playful voice');
    expect(out.estimatedSpokenSeconds).toBeGreaterThan(0);
  });

  it('builds prompts directly from plan fields', () => {
    const plan = base();
    expect(buildPart1Prompt(plan, settings())).toBe(plan.segments[0].prompt);
    expect(buildPart2Prompt(plan, settings())).toBe(plan.segments[1].prompt);
  });

  it('tells the splitter the same speaking budget as the UI (about 39 words, 7.5s per part)', () => {
    expect(SPLIT_SYSTEM_INSTRUCTION).toContain('About 15 seconds of speech (about 39 words)');
    expect(SPLIT_SYSTEM_INSTRUCTION).toContain('at most about 7.5 seconds of speech');
  });

  it('never sends U+2014 to the text model', () => {
    expect(SPLIT_SYSTEM_INSTRUCTION).not.toContain(EM_DASH);
    expect(JSON.stringify(PLAN_JSON_SCHEMA)).not.toContain(EM_DASH);
    const prompt = buildSplitPrompt(
      `First line${EM_DASH}pause.\nSecond line.`,
      settings({ voiceHint: `calm${EM_DASH}warm` }),
    );
    expect(prompt).not.toContain(EM_DASH);
    expect(prompt).toContain('First line, pause.\nSecond line.');
  });
});

describe('verbatim check with ambiguous parentheticals', () => {
  it('accepts a model that moved an unlisted parenthetical cue into the action', async () => {
    const script =
      'I never thought a ten minute walk after dinner could matter. (glances at her watch dramatically) ' +
      'But it lowers the blood sugar spike from your meal. Try it tonight and tell me how you feel.';
    const text = new MockTextClient({
      respond: () => ({
        character: 'a relaxed creator',
        setting: 'a quiet street at dusk',
        voice: 'a warm, clear voice',
        audio: 'quiet street ambience',
        part1: {
          dialogue: 'I never thought a ten minute walk after dinner could matter.',
          action: 'glances at her watch dramatically',
          camera: 'handheld selfie',
          onScreenText: '',
        },
        part2: {
          dialogue: 'But it lowers the blood sugar spike from your meal. Try it tonight and tell me how you feel.',
          action: 'smiles and keeps walking',
          camera: 'handheld selfie',
          onScreenText: '',
        },
        warnings: [],
      }),
    });
    const { plan } = await planner(text).split({ script, settings: settings() });
    expect(plan.source).toBe('llm');
    expect(plan.segments[0].prompt).toContain('The person glances at her watch dramatically.');
  });

  it('treats "(she leans in)" style cues as directions in the fallback', () => {
    const plan = fallbackPlan('Here is the secret (she leans in) nobody tells you about sleep.', settings());
    expect(plan.segments[0].dialogue).toBe('Here is the secret nobody tells you about sleep.');
    expect(plan.segments[0].action).toBe('leans in');
    expect(plan.segments[0].prompt).toContain(
      'The person leans in. The person in <IMAGE_REF_0> says, with natural lip sync:',
    );
  });

  it('writes several cues as one grammatical action sentence', () => {
    const plan = fallbackPlan(
      '(smiles) Stop scrolling, this changed my skin. [holds up the jar] Link in bio.',
      settings(),
    );
    expect(plan.segments[0].action).toBe('smiles; holds up the jar');
    expect(plan.segments[0].prompt).toContain('The person smiles, then holds up the jar.');
    expect(actionSentence('The person', 'She walks into frame')).toBe('The person walks into frame.');
    expect(actionSentence('The person', 'Close-up of the jar. smiles')).toBe('Close-up of the jar. The person smiles.');
  });

  it('does not describe talking in a part without dialogue, and notes a mid-sentence split', () => {
    const short = fallbackPlan('Hi.', settings());
    expect(short.segments[1].dialogue).toBe('');
    expect(short.segments[1].prompt).toContain('No dialogue.');
    expect(short.segments[1].prompt).not.toMatch(/talking|explaining/);

    const long = fallbackPlan(
      'this sentence has no punctuation at all and it keeps going and going because nobody ever stopped the writer from rambling on about nothing',
      settings(),
    );
    expect(long.segments[1].dialogue).not.toBe('');
    expect(long.segments[0].prompt).toContain('pauses briefly mid-thought');
  });
});
