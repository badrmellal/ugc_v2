import { FlaskConical, Smartphone } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  LIMITS,
  RESOLUTIONS,
  type GenerationSettings,
  type ImageMode,
  type PricingInfo,
  type Resolution,
  type VideoStyle,
} from '@shared/api';
import { formatUsd } from '../lib/format';
import {
  IMAGE_MODE_OPTIONS,
  LANGUAGES,
  RESOLUTION_LABELS,
  STYLE_OPTIONS,
  isKnownLanguage,
  pricePerVideo,
} from '../lib/options';
import { VOICE_HINT_MAX_CHARS, type CreateFormIssues } from '../lib/validation';
import { cn } from '../lib/cn';
import { Collapsible } from './Collapsible';
import { Field, describedBy, inputClass } from './Field';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';

type Patch = Partial<GenerationSettings>;

const STYLE_ICONS: Record<VideoStyle, ReactNode> = {
  ugc: <Smartphone className="size-4 shrink-0" aria-hidden="true" />,
  scientific: <FlaskConical className="size-4 shrink-0" aria-hidden="true" />,
};

export function SettingsPanel({
  settings,
  onChange,
  pricing,
  resolutions = RESOLUTIONS,
  issues,
}: {
  settings: GenerationSettings;
  onChange: (patch: Patch) => void;
  pricing: PricingInfo;
  resolutions?: readonly Resolution[];
  issues: CreateFormIssues;
}) {
  const styleOptions: SegmentOption<VideoStyle>[] = STYLE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    icon: STYLE_ICONS[option.value],
  }));
  const imageModeOptions: SegmentOption<ImageMode>[] = IMAGE_MODE_OPTIONS.map((option) => ({ ...option }));

  return (
    <div className="space-y-6">
      <SegmentedControl
        name="style"
        legend="Style"
        layout="cards"
        value={settings.style}
        options={styleOptions}
        onChange={(style) => onChange({ style })}
      />
      <ResolutionPicker
        value={settings.resolution}
        resolutions={resolutions}
        pricing={pricing}
        onChange={(resolution) => onChange({ resolution })}
      />
      <SegmentedControl
        name="imageMode"
        legend="Image mode"
        layout="cards"
        value={settings.imageMode}
        options={imageModeOptions}
        onChange={(imageMode) => onChange({ imageMode })}
      />
      <Collapsible
        summary="Advanced: language, voice and directions"
        defaultOpen={Boolean(issues.language || issues.voiceHint || issues.extraDirections)}
      >
        <AdvancedSettings settings={settings} onChange={onChange} issues={issues} />
      </Collapsible>
    </div>
  );
}

function ResolutionPicker({
  value,
  resolutions,
  pricing,
  onChange,
}: {
  value: Resolution;
  resolutions: readonly Resolution[];
  pricing: PricingInfo;
  onChange: (value: Resolution) => void;
}) {
  const options: SegmentOption<Resolution>[] = resolutions.map((resolution) => ({
    value: resolution,
    label: RESOLUTION_LABELS[resolution],
    description: (
      <span className="tabular-nums">
        {formatUsd(pricePerVideo(pricing, resolution))}
        <span className="sr-only"> video output</span> per 20s
      </span>
    ),
  }));
  return (
    <div>
      <SegmentedControl
        name="resolution"
        legend="Resolution"
        layout="cards"
        columns={4}
        value={value}
        options={options}
        onChange={onChange}
      />
      <p className="mt-1.5 text-xs text-muted">
        Prices are the video output cost of one 20-second video; input and text tokens are extra (see the estimate).
        Higher resolutions take longer to generate.
      </p>
    </div>
  );
}

const OTHER = '__other__';

function AdvancedSettings({
  settings,
  onChange,
  issues,
}: {
  settings: GenerationSettings;
  onChange: (patch: Patch) => void;
  issues: CreateFormIssues;
}) {
  const id = useId();
  const [otherLanguage, setOtherLanguage] = useState(() => !isKnownLanguage(settings.language));
  const selectValue = otherLanguage ? OTHER : settings.language;

  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface-2/50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Spoken language" htmlFor={`${id}-lang`} error={otherLanguage ? null : issues.language}>
          <select
            id={`${id}-lang`}
            value={selectValue}
            onChange={(event) => {
              if (event.target.value === OTHER) {
                setOtherLanguage(true);
                onChange({ language: '' });
              } else {
                setOtherLanguage(false);
                onChange({ language: event.target.value });
              }
            }}
            className={inputClass}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label} ({language.code})
              </option>
            ))}
            <option value={OTHER}>Other...</option>
          </select>
        </Field>
        {otherLanguage && (
          <Field
            label="Language code (BCP-47)"
            htmlFor={`${id}-lang-other`}
            hint="For example: ca, sr-Latn, yue"
            hintId={`${id}-lang-other-hint`}
            error={issues.language}
            errorId={`${id}-lang-other-error`}
          >
            <input
              id={`${id}-lang-other`}
              value={settings.language}
              onChange={(event) => onChange({ language: event.target.value.trim() })}
              placeholder="e.g. ca"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={issues.language ? true : undefined}
              aria-describedby={describedBy(issues.language ? `${id}-lang-other-error` : `${id}-lang-other-hint`)}
              className={inputClass}
            />
          </Field>
        )}
      </div>
      <Field
        label="Voice direction"
        htmlFor={`${id}-voice`}
        hint="Optional. For example: warm, energetic female voice, American accent, conversational."
        hintId={`${id}-voice-hint`}
        error={issues.voiceHint}
        errorId={`${id}-voice-error`}
        aside={
          settings.voiceHint.length > VOICE_HINT_MAX_CHARS * 0.8 ? (
            <span className={cn('tabular-nums', issues.voiceHint && 'text-danger')}>
              {settings.voiceHint.length} / {VOICE_HINT_MAX_CHARS}
            </span>
          ) : undefined
        }
      >
        <input
          id={`${id}-voice`}
          value={settings.voiceHint}
          onChange={(event) => onChange({ voiceHint: event.target.value })}
          aria-invalid={issues.voiceHint ? true : undefined}
          aria-describedby={issues.voiceHint ? `${id}-voice-error` : `${id}-voice-hint`}
          className={inputClass}
        />
      </Field>
      <Field
        label="Extra directions"
        htmlFor={`${id}-extra`}
        hint="Optional. Applied to both parts: setting, props, wardrobe, lighting."
        hintId={`${id}-extra-hint`}
        error={issues.extraDirections}
        errorId={`${id}-extra-error`}
        aside={
          <span
            className={cn(
              'tabular-nums',
              settings.extraDirections.length > LIMITS.extraDirectionsMaxChars && 'text-danger',
            )}
          >
            {settings.extraDirections.length} / {LIMITS.extraDirectionsMaxChars}
          </span>
        }
      >
        <textarea
          id={`${id}-extra`}
          value={settings.extraDirections}
          onChange={(event) => onChange({ extraDirections: event.target.value })}
          rows={3}
          aria-invalid={issues.extraDirections ? true : undefined}
          aria-describedby={issues.extraDirections ? `${id}-extra-error` : `${id}-extra-hint`}
          className={cn(inputClass, 'resize-y')}
        />
      </Field>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={settings.reinforceCharacterOnExtend}
          onChange={(event) => onChange({ reinforceCharacterOnExtend: event.target.checked })}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        <span>
          <span className="font-medium">Reinforce character in part 2</span>
          <span className="block text-xs text-muted">
            Sends the character image again with the extension turn for a stronger identity lock. Adds a small amount of
            input cost.
          </span>
        </span>
      </label>
    </div>
  );
}
