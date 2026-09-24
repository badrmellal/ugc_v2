import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Scissors, Sparkles } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { AppConfigResponse, GenerationDTO, GenerationSettings, PlanRequest, ScriptPlan } from '@shared/api';
import { createGeneration, previewPlan, regenerateGeneration } from '../lib/api';
import { clearDraft, loadDraft, mergeSettings, saveDraft } from '../lib/draft';
import { isNotFound } from '../lib/errors';
import {
  invalidateAfterGenerationChange,
  queryKeys,
  useAppConfig,
  useDocumentTitle,
  useGeneration,
} from '../lib/hooks';
import { IMAGE_MODE_LABELS, RESOLUTION_LABELS, STYLE_LABELS, languageLabel } from '../lib/options';
import { preventImplicitSubmit } from '../lib/forms';
import { planBasisKey, planForRegenerate, planForSubmit } from '../lib/plan';
import { issueList, validateCreateForm } from '../lib/validation';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CostEstimate } from '../components/CostEstimateCard';
import { ErrorAlert, ErrorState } from '../components/ErrorAlert';
import { ImageDropZone, type SelectedImage } from '../components/ImageDropZone';
import { PlanEditor } from '../components/PlanEditor';
import { ScriptEditor } from '../components/ScriptEditor';
import { SettingsPanel } from '../components/SettingsPanel';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { NotFoundState } from './NotFoundPage';

export function CreatePage() {
  const [params] = useSearchParams();
  const fromId = params.get('from');
  const config = useAppConfig();
  const source = useGeneration(fromId, { poll: false });
  useDocumentTitle(fromId ? 'Edit and regenerate' : 'Create');

  if (!config.data) {
    if (config.isError) {
      return (
        <ErrorState
          title="Could not load the app settings"
          error={config.error}
          onRetry={() => void config.refetch()}
          retrying={config.isFetching}
        />
      );
    }
    return <CreateSkeleton />;
  }

  if (fromId && !source.data) {
    if (source.isError) {
      return isNotFound(source.error) ? (
        <NotFoundState
          title="Source video not found"
          message="It may have been deleted. You can start a new video instead."
        />
      ) : (
        <ErrorState
          title="Could not load the source video"
          error={source.error}
          onRetry={() => void source.refetch()}
          retrying={source.isFetching}
        />
      );
    }
    return <CreateSkeleton />;
  }

  return <CreateForm key={fromId ?? 'new'} config={config.data} source={fromId ? (source.data ?? null) : null} />;
}

function initialState(config: AppConfigResponse, source: GenerationDTO | null) {
  const stored = source ? { script: source.script, settings: source.settings } : loadDraft();
  const settings = mergeSettings(config.defaults, stored?.settings ?? {});
  if (!config.resolutions.includes(settings.resolution)) settings.resolution = config.defaults.resolution;
  return { script: stored?.script ?? '', settings };
}

function normalizeSettings(settings: GenerationSettings): GenerationSettings {
  return {
    ...settings,
    language: settings.language.trim(),
    voiceHint: settings.voiceHint.trim(),
    extraDirections: settings.extraDirections.trim(),
  };
}

interface SubmitVars {
  script: string;
  settings: GenerationSettings;
  /** Split to send: see planForSubmit (new video) and planForRegenerate (edit and regenerate). */
  plan: ScriptPlan | null | undefined;
  image: File | null;
}

function CreateForm({ config, source }: { config: AppConfigResponse; source: GenerationDTO | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const checklistId = useId();
  const regenerating = source !== null;

  const [initial] = useState(() => initialState(config, source));
  // The source's split as loaded; later refetches of the source must not change what counts as "untouched".
  const [sourcePlan] = useState<ScriptPlan | null>(() => source?.plan ?? null);
  const [script, setScript] = useState(initial.script);
  const [settings, setSettings] = useState<GenerationSettings>(initial.settings);
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [plan, setPlan] = useState<ScriptPlan | null>(sourcePlan);
  const [planBasis, setPlanBasis] = useState<string | null>(() =>
    sourcePlan ? planBasisKey(initial.script, initial.settings) : null,
  );
  const [planEdited, setPlanEdited] = useState(false);
  const [confirmReplacePlan, setConfirmReplacePlan] = useState(false);

  // Keep the unsent script and settings across reloads (new videos only).
  useEffect(() => {
    if (regenerating) return;
    const timer = window.setTimeout(() => saveDraft({ script, settings }), 500);
    return () => window.clearTimeout(timer);
  }, [regenerating, script, settings]);

  const issues = validateCreateForm({ script, settings, hasImage: regenerating || image !== null });
  const blocking = issueList(issues);
  const canPlan = !issues.script && !issues.language && !issues.voiceHint && !issues.extraDirections;
  const planStale = plan !== null && planBasis !== planBasisKey(script, settings);

  const planMutation = useMutation({
    mutationFn: (body: PlanRequest) => previewPlan(body),
    onSuccess: (result, body) => {
      setPlan(result);
      setPlanBasis(planBasisKey(body.script, body.settings));
      setPlanEdited(false);
      setConfirmReplacePlan(false);
    },
  });

  const submitMutation = useMutation({
    mutationFn: (vars: SubmitVars): Promise<GenerationDTO> => {
      if (source) {
        return regenerateGeneration(source.id, {
          mode: 'full',
          script: vars.script,
          settings: vars.settings,
          // Omitted: keep the source's split. null: split the (possibly edited) script again.
          ...(vars.plan !== undefined ? { plan: vars.plan } : {}),
        });
      }
      if (!vars.image) return Promise.reject(new Error('Add a character image.'));
      return createGeneration(
        { script: vars.script, settings: vars.settings, ...(vars.plan ? { plan: vars.plan } : {}) },
        vars.image,
      );
    },
    onSuccess: (dto) => {
      queryClient.setQueryData(queryKeys.generation(dto.id), dto);
      invalidateAfterGenerationChange(queryClient);
      if (!regenerating) clearDraft();
      toast.push({
        tone: 'success',
        title: regenerating ? 'Regeneration queued' : 'Generation queued',
        description: 'You can follow the progress on the next page.',
      });
      void navigate(`/generations/${dto.id}`);
    },
  });

  const requestPlan = () => planMutation.mutate({ script: script.trim(), settings: normalizeSettings(settings) });

  const onPreviewSplit = () => {
    if (plan && planEdited) {
      planMutation.reset();
      setConfirmReplacePlan(true);
    } else {
      requestPlan();
    }
  };

  const discardPlan = () => {
    setPlan(null);
    setPlanBasis(null);
    setPlanEdited(false);
    planMutation.reset();
  };

  // Generating while a preview is still running would split the script twice and ignore the preview.
  const waitingForSplit = planMutation.isPending;
  const submitNotes = waitingForSplit ? [...blocking, 'Wait for the split preview to finish.'] : blocking;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (blocking.length > 0 || waitingForSplit || submitMutation.isPending) return;
    const planState = { stale: planStale, edited: planEdited };
    submitMutation.mutate({
      script: script.trim(),
      settings: normalizeSettings(settings),
      plan: source ? planForRegenerate(plan, sourcePlan, planState) : planForSubmit(plan, planState),
      image: image?.file ?? null,
    });
  };

  const splitStatus = !plan
    ? 'Automatic'
    : planStale
      ? planEdited
        ? 'Edited (out of date)'
        : 'Automatic (preview out of date)'
      : planEdited
        ? 'Edited'
        : 'Previewed';

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        {regenerating && source ? (
          <>
            <Link
              to={`/generations/${encodeURIComponent(source.id)}`}
              className="inline-flex items-center gap-1 rounded-md text-sm text-muted hover:text-fg"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to {source.title || 'the original video'}
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">Edit and regenerate</h1>
            <p className="max-w-2xl text-sm text-muted">
              Adjust the script, settings or split, then generate a new version. The original video stays in your
              history.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Create a 20-second video</h1>
            <p className="max-w-2xl text-sm text-muted">
              One script and one character image become one continuous vertical video: a 10-second generation plus a
              10-second extension of the same Omni interaction.
            </p>
          </>
        )}
      </header>

      <form
        onSubmit={onSubmit}
        onKeyDown={preventImplicitSubmit}
        noValidate
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start"
      >
        <div className="min-w-0 space-y-6">
          <Card>
            <ScriptEditor value={script} onChange={setScript} />
          </Card>

          <Card>{source ? <SourceImage source={source} /> : <ImageDropZone value={image} onChange={setImage} />}</Card>

          <Card title="Style and output">
            <SettingsPanel
              settings={settings}
              onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
              pricing={config.pricing}
              resolutions={config.resolutions}
              issues={{
                language: issues.language,
                voiceHint: issues.voiceHint,
                extraDirections: issues.extraDirections,
              }}
            />
          </Card>

          <Card
            title="Script split"
            description="Optional. Review how the script is divided into two 10-second parts, and edit it before generating."
            actions={
              !plan && (
                <Button
                  size="sm"
                  onClick={onPreviewSplit}
                  disabled={!canPlan}
                  loading={planMutation.isPending}
                  icon={<Scissors className="size-4" aria-hidden="true" />}
                >
                  Preview split
                </Button>
              )
            }
          >
            {plan ? (
              <PlanEditor
                plan={plan}
                onChange={(next) => {
                  setPlan(next);
                  setPlanEdited(true);
                }}
                stale={planStale}
                edited={planEdited}
                onRefresh={onPreviewSplit}
                refreshing={planMutation.isPending}
                onDiscard={discardPlan}
              />
            ) : planMutation.isPending ? (
              <div className="space-y-3" aria-busy="true" aria-label="Splitting the script">
                <Skeleton className="h-16" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Skeleton className="h-40" />
                  <Skeleton className="h-40" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">
                {canPlan
                  ? 'If you skip this, the backend splits the script automatically when you generate.'
                  : 'Write a script first. If you skip this step, the backend splits the script automatically.'}
              </p>
            )}
            {planMutation.isError && (
              <ErrorAlert className="mt-4" error={planMutation.error} title="Could not preview the split" />
            )}
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20" aria-label="Cost and generate">
          <Card title="Estimated cost" description={`${RESOLUTION_LABELS[settings.resolution]}, 2 turns of 10 seconds`}>
            <CostEstimate
              resolution={settings.resolution}
              mode="full"
              reinforceCharacterOnExtend={settings.reinforceCharacterOnExtend}
              hasPlan={
                (source
                  ? planForRegenerate(plan, sourcePlan, { stale: planStale, edited: planEdited })
                  : planForSubmit(plan, { stale: planStale, edited: planEdited })) != null
              }
            />
          </Card>

          <Card>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">Style</dt>
              <dd className="text-right">{STYLE_LABELS[settings.style]}</dd>
              <dt className="text-muted">Resolution</dt>
              <dd className="text-right">{RESOLUTION_LABELS[settings.resolution]}, 9:16</dd>
              <dt className="text-muted">Image</dt>
              <dd className="text-right">{IMAGE_MODE_LABELS[settings.imageMode]}</dd>
              <dt className="text-muted">Language</dt>
              <dd className="truncate text-right">{settings.language ? languageLabel(settings.language) : '-'}</dd>
              <dt className="text-muted">Split</dt>
              <dd className="text-right">{splitStatus}</dd>
            </dl>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="mt-4 w-full"
              disabled={submitNotes.length > 0}
              loading={submitMutation.isPending}
              aria-describedby={submitNotes.length > 0 ? checklistId : undefined}
              icon={<Sparkles className="size-5" aria-hidden="true" />}
            >
              {regenerating ? 'Regenerate video' : 'Generate 20s video'}
            </Button>

            {submitNotes.length > 0 && (
              <ul id={checklistId} className="mt-3 space-y-1 text-xs text-muted">
                {submitNotes.map((issue) => (
                  <li key={issue} className="flex gap-1.5">
                    <span aria-hidden="true">•</span>
                    {issue}
                  </li>
                ))}
              </ul>
            )}
            {submitMutation.isError && <ErrorAlert className="mt-4" error={submitMutation.error} />}
          </Card>

          <HowItWorks />
        </aside>
      </form>

      <ConfirmDialog
        open={confirmReplacePlan}
        onClose={() => setConfirmReplacePlan(false)}
        onConfirm={requestPlan}
        pending={planMutation.isPending}
        error={planMutation.error}
        title="Replace your edited split?"
        description="Refreshing runs the splitter on the current script and replaces your edits."
        confirmLabel="Replace"
        cancelLabel="Keep my edits"
      />
    </div>
  );
}

function SourceImage({ source }: { source: GenerationDTO }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Character image</p>
      <div className="flex gap-4">
        <img
          src={source.characterImageUrl}
          alt="Character image of the original video"
          className="h-36 w-24 shrink-0 rounded-lg bg-surface-2 object-cover sm:h-40 sm:w-28"
        />
        <div className="space-y-2 text-sm text-muted">
          <p>This regeneration reuses the character image of the original video. It cannot be changed here.</p>
          <p>
            To use a different image,{' '}
            <Link to="/" className="font-medium text-accent-text underline-offset-2 hover:underline">
              start a new video
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    'Your script is split into two 10-second parts that share one continuity bible.',
    'Part 1 (0-10s) is generated from your character image.',
    'Part 2 (10-20s) extends the same Omni interaction, so character, voice, audio and motion carry over.',
    'You get one 20-second MP4 to preview and download.',
  ];
  return (
    <section aria-labelledby="how-it-works" className="rounded-2xl border border-line px-4 py-4 sm:px-5">
      <h2 id="how-it-works" className="text-sm font-semibold">
        How it works
      </h2>
      <ol className="mt-3 space-y-2 text-sm text-muted">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-fg">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CreateSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
