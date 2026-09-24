/** Fakes of the ports used by the HTTP layer. They never call Google or ffmpeg. */
import { copyFile } from 'node:fs/promises';
import type {
  InteractionState,
  MediaTools,
  ProbeResult,
  ScriptPlanner,
  ScriptSplitResult,
  TextModelClient,
  UploadedFileRef,
  UsageInfo,
  VideoModelClient,
} from '../../src/core/ports.js';
import type { GenerationSettings, ScriptPlan, SegmentPlan } from '../../src/shared/api.js';

function segment(index: 1 | 2, dialogue: string): SegmentPlan {
  return {
    index,
    startSec: index === 1 ? 0 : 10,
    endSec: index === 1 ? 10 : 20,
    dialogue,
    action: index === 1 ? 'Looks at the camera and starts talking' : 'Holds up the product and smiles',
    camera: 'Handheld selfie framing, medium close-up',
    onScreenText: '',
    prompt: '',
  };
}

/** Deterministic planner: splits the words in half; `finalize` rebuilds prompts from the fields. */
export class FakePlanner implements ScriptPlanner {
  splitCalls = 0;
  finalizeCalls = 0;
  failSplit = false;
  /** Model reported by split(); null simulates the deterministic fallback. */
  model: string | null = 'fake-splitter';

  async split(input: { script: string; settings: GenerationSettings }): Promise<ScriptSplitResult> {
    this.splitCalls += 1;
    if (this.failSplit) throw new Error('splitter exploded');
    const words = input.script.trim().split(/\s+/);
    const half = Math.ceil(words.length / 2);
    const draft: ScriptPlan = {
      source: 'llm',
      character: 'The person in the reference image',
      setting: 'A bright, tidy kitchen',
      voice: 'Warm, upbeat voice',
      audio: 'Soft room tone',
      language: input.settings.language,
      segments: [segment(1, words.slice(0, half).join(' ')), segment(2, words.slice(half).join(' '))],
      warnings: [],
      estimatedSpokenSeconds: 8,
    };
    const plan = { ...this.finalize(draft, input.settings), source: 'llm' as const };
    const usage: UsageInfo | null = this.model ? { inputTokens: 300, outputTokens: 200 } : null;
    return { plan, usage, costUsd: this.model ? 0.0021 : 0, model: this.model };
  }

  finalize(plan: ScriptPlan, settings: GenerationSettings): ScriptPlan {
    this.finalizeCalls += 1;
    if (!plan.character.trim()) throw new Error('character description is required');
    const [a, b] = plan.segments;
    const build = (s: SegmentPlan, index: 1 | 2): SegmentPlan => ({
      ...s,
      index,
      startSec: index === 1 ? 0 : 10,
      endSec: index === 1 ? 10 : 20,
      prompt: `[${settings.style}/${settings.imageMode}] part ${index}: ${s.dialogue} | ${s.action} | ${s.camera}`,
    });
    return { ...plan, segments: [build(a, 1), build(b, 2)] };
  }
}

function unused(name: string): never {
  throw new Error(`${name} is not used by the HTTP layer`);
}

export class FakeVideoClient implements VideoModelClient {
  readonly model = 'fake-omni';
  readonly isMock = true;
  async uploadImage(): Promise<UploadedFileRef> {
    return unused('uploadImage');
  }
  async startTurn(): Promise<InteractionState> {
    return unused('startTurn');
  }
  async getInteraction(): Promise<InteractionState> {
    return unused('getInteraction');
  }
  async cancel(): Promise<void> {
    return unused('cancel');
  }
  async downloadVideo(): Promise<void> {
    return unused('downloadVideo');
  }
}

export class FakeTextClient implements TextModelClient {
  readonly model = 'fake-text';
  async generateJson(): Promise<{ data: unknown; usage: UsageInfo | null }> {
    return unused('generateJson');
  }
}

/** normalizeImage copies the bytes (the real ffmpeg re-encode is covered by the media tests). */
export class FakeMediaTools implements MediaTools {
  normalizeCalls = 0;
  failNormalize: string | null = null;

  async normalizeImage(input: string, output: string): Promise<{ width: number; height: number }> {
    this.normalizeCalls += 1;
    if (this.failNormalize) {
      throw Object.assign(new Error('Image could not be decoded'), { code: this.failNormalize });
    }
    await copyFile(input, output);
    return { width: 64, height: 64 };
  }
  async probe(): Promise<ProbeResult> {
    return unused('probe');
  }
  async faststart(): Promise<void> {
    return unused('faststart');
  }
  async concat(): Promise<void> {
    return unused('concat');
  }
  async thumbnail(): Promise<void> {
    return unused('thumbnail');
  }
  async synthesizeClip(): Promise<void> {
    return unused('synthesizeClip');
  }
}
