import { describe, expect, it } from 'vitest';
import { fallbackPlan } from '../src/script/fallback.js';
import { finalizePlan } from '../src/script/finalize.js';
import { buildSplitPrompt } from '../src/script/planner.js';
import { DEFAULT_SETTINGS, type GenerationSettings } from '../src/shared/api.js';

const SCRIPT =
  'This SUV just landed on our lot and it is spotless. Low miles, one owner, and it drives like new. Come see it this weekend before it is gone.';

function settings(over: Partial<GenerationSettings>): GenerationSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

describe('content themes', () => {
  it('Bandys Cars puts the dealership and its sign into both prompts', () => {
    for (const style of ['ugc', 'scientific'] as const) {
      const plan = fallbackPlan(SCRIPT, settings({ theme: 'bandys_cars', style }));
      expect(plan.setting).toContain('Bandys Cars');
      for (const seg of plan.segments) {
        expect(seg.prompt).toContain('reads "Bandys Cars"');
        expect(seg.prompt).not.toContain('—');
      }
      // The continuity bible is repeated verbatim in the extension.
      expect(plan.segments[1].prompt).toContain(plan.setting);
      expect(plan.segments[1].prompt.startsWith('Extend this video.')).toBe(true);
    }
  });

  it('Technology, AI & Robotics uses a tech studio or robotics lab', () => {
    const ugc = fallbackPlan(SCRIPT, settings({ theme: 'tech_ai_robotics', style: 'ugc' }));
    const lab = fallbackPlan(SCRIPT, settings({ theme: 'tech_ai_robotics', style: 'scientific' }));
    expect(ugc.setting).toMatch(/tech studio desk/);
    expect(lab.setting).toMatch(/robotics lab/);
    expect(lab.character).toMatch(/robotics and AI engineer/);
  });

  it('a themed plan keeps the theme location even if the splitter wrote another one, unless the user edited it', () => {
    const base = fallbackPlan(SCRIPT, settings({ theme: 'bandys_cars' }));
    const drifted = finalizePlan(
      { ...base, source: 'llm', setting: 'a cozy kitchen' },
      settings({ theme: 'bandys_cars' }),
    );
    expect(drifted.setting).toContain('Bandys Cars');
    const edited = finalizePlan(
      { ...base, source: 'user', setting: 'the Bandys Cars service bay with a car on a lift' },
      settings({ theme: 'bandys_cars' }),
    );
    expect(edited.setting).toBe('the Bandys Cars service bay with a car on a lift');
    expect(edited.segments[0].prompt).toContain('service bay');
  });

  it('general keeps the style defaults', () => {
    const plan = fallbackPlan(SCRIPT, settings({ theme: 'general' }));
    expect(plan.setting).not.toContain('Bandys Cars');
    expect(plan.setting).toMatch(/home interior/);
  });

  it('gives the splitter the theme rules', () => {
    const cars = buildSplitPrompt(SCRIPT, settings({ theme: 'bandys_cars' }));
    expect(cars).toContain('Theme: Bandys Cars.');
    expect(cars).toContain('Never invent car makes, models, prices');
    expect(buildSplitPrompt(SCRIPT, settings({ theme: 'tech_ai_robotics' }))).toContain(
      'Theme: Technology, AI & Robotics.',
    );
    expect(buildSplitPrompt(SCRIPT, settings({ theme: 'general' }))).not.toContain('Theme:');
  });

  it('treats settings saved before themes existed as general', () => {
    const legacy = { ...DEFAULT_SETTINGS } as Partial<GenerationSettings>;
    delete legacy.theme;
    const plan = fallbackPlan(SCRIPT, legacy as GenerationSettings);
    expect(plan.setting).toMatch(/home interior/);
  });
});
