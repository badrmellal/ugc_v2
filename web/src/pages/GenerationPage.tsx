import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { STAGE_LABELS, isTerminalStatus, type GenerationDTO, type GenerationStatus } from '@shared/api';
import { describeError, isNotFound } from '../lib/errors';
import {
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  formatVideoLength,
  secondsBetween,
} from '../lib/format';
import { invalidateAfterGenerationChange, useAppConfig, useDocumentTitle, useGeneration, useNow } from '../lib/hooks';
import { IMAGE_MODE_LABELS, RESOLUTION_LABELS, STYLE_LABELS, languageLabel } from '../lib/options';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapsible } from '../components/Collapsible';
import { CostBreakdownView } from '../components/CostBreakdownView';
import { ErrorState } from '../components/ErrorAlert';
import { EventLog } from '../components/EventLog';
import { GenerationActions } from '../components/GenerationActions';
import { PhonePlayer } from '../components/PhonePlayer';
import { PlanSummary } from '../components/PlanSummary';
import { ProgressBar } from '../components/ProgressBar';
import { Skeleton } from '../components/Skeleton';
import { StageStepper } from '../components/StageStepper';
import { StatusBadge, Tag } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { NotFoundState } from './NotFoundPage';

export function GenerationPage() {
  const { id = '' } = useParams();
  const query = useGeneration(id);
  const generation = query.data;
  useDocumentTitle(generation?.title || 'Generation');
  useStatusTransitions(generation);

  if (!generation) {
    if (query.isError) {
      return isNotFound(query.error) ? (
        <NotFoundState title="Video not found" message="It may have been deleted, or the link is wrong." />
      ) : (
        <ErrorState
          title="Could not load this video"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      );
    }
    return <GenerationSkeleton />;
  }

  return (
    <GenerationView
      generation={generation}
      liveError={query.isError ? query.error : null}
      onRetry={() => void query.refetch()}
      retrying={query.isFetching}
    />
  );
}

/** Toast and refresh history/budget when the job being watched finishes. */
function useStatusTransitions(generation: GenerationDTO | undefined) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const previous = useRef<{ id: string; status: GenerationStatus } | null>(null);

  useEffect(() => {
    if (!generation) return;
    const before = previous.current;
    previous.current = { id: generation.id, status: generation.status };
    if (!before || before.id !== generation.id || before.status === generation.status) return;
    if (isTerminalStatus(before.status) || !isTerminalStatus(generation.status)) return;
    invalidateAfterGenerationChange(queryClient);
    if (generation.status === 'succeeded') {
      toast.push({ tone: 'success', title: 'Your video is ready', description: generation.title });
    } else if (generation.status === 'failed') {
      toast.push({ tone: 'error', title: 'Generation failed', description: generation.error?.message });
    }
  }, [generation, queryClient, toast]);
}

function GenerationView({
  generation: g,
  liveError,
  onRetry,
  retrying,
}: {
  generation: GenerationDTO;
  liveError: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const active = !isTerminalStatus(g.status);
  const now = useNow(1000, active);
  const config = useAppConfig();

  return (
    <div className="space-y-6">
      <GenerationHeader generation={g} now={now} />

      {liveError ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm"
        >
          <WifiOff className="size-4 shrink-0 text-warn" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <span className="font-medium">Live updates paused.</span>{' '}
            <span className="text-muted">{describeError(liveError).message}</span>
          </p>
          <Button
            size="sm"
            onClick={onRetry}
            loading={retrying}
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <PhonePlayer generation={g} />
          <GenerationActions generation={g} />
        </div>

        <div className="min-w-0 space-y-6">
          <ProgressCard generation={g} now={now} />
          {g.error && <ErrorPanel generation={g} />}
          <div className="grid gap-6 xl:grid-cols-2">
            <CostPanel generation={g} />
            <OutputPanel generation={g} model={config.data?.models.video ?? null} />
          </div>
          <Card title="Script split" description="The continuity bible and the two parts sent to Omni.">
            {g.plan ? (
              <PlanSummary plan={g.plan} />
            ) : (
              <p className="text-sm text-muted">
                {active ? 'The script has not been split yet.' : 'No split was recorded for this video.'}
              </p>
            )}
          </Card>
          <Card title="Script">
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{g.script}</p>
          </Card>
          <Card title="Event log" description={`${g.events.length} ${g.events.length === 1 ? 'event' : 'events'}`}>
            <EventLog events={g.events} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function GenerationHeader({ generation: g, now }: { generation: GenerationDTO; now: number }) {
  return (
    <header className="space-y-2">
      <Link to="/history" className="inline-flex items-center gap-1 rounded-md text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />
        History
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">{g.title || 'Untitled video'}</h1>
        <StatusBadge status={g.status} progress={g.progress} />
        {g.regenerationMode && (
          <Tag>{g.regenerationMode === 'part2' ? 'Part 2 regeneration' : 'Full regeneration'}</Tag>
        )}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          Created{' '}
          <time dateTime={g.createdAt} title={formatDateTime(g.createdAt)}>
            {formatRelativeTime(g.createdAt, now)}
          </time>
        </span>
        {g.parentId && (
          <span>
            Regenerated from{' '}
            <Link
              to={`/generations/${encodeURIComponent(g.parentId)}`}
              className="font-medium text-accent-text underline-offset-2 hover:underline"
            >
              the original video
            </Link>
          </span>
        )}
        <span>
          {STYLE_LABELS[g.settings.style]} · {RESOLUTION_LABELS[g.settings.resolution]} · 9:16
        </span>
      </p>
    </header>
  );
}

const STATUS_TITLES: Record<GenerationStatus, string> = {
  queued: 'Waiting for a worker',
  running: '',
  succeeded: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
};

function ProgressCard({ generation: g, now }: { generation: GenerationDTO; now: number }) {
  const active = !isTerminalStatus(g.status);
  const start = g.startedAt ?? g.createdAt;
  const end = g.completedAt ?? (active ? now : g.updatedAt);
  const elapsed = secondsBetween(start, end);
  const title = g.status === 'running' ? STAGE_LABELS[g.stage] : STATUS_TITLES[g.status];
  const tone =
    g.status === 'succeeded' ? 'ok' : g.status === 'failed' ? 'danger' : g.status === 'canceled' ? 'muted' : 'accent';
  const value = g.status === 'succeeded' ? 100 : g.progress;

  return (
    <Card title="Progress">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium" aria-live="polite">
            {title}
          </p>
          <p className="text-sm font-semibold tabular-nums">{formatPercent(value)}</p>
        </div>
        <ProgressBar value={value} tone={tone} label="Overall progress" />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
          <span>
            {active ? 'Elapsed' : 'Took'} {formatDuration(elapsed)}
          </span>
          {active && g.etaSeconds !== null && <span>About {formatDuration(g.etaSeconds)} left</span>}
          {active && g.etaSeconds === null && <span>Estimating time left...</span>}
        </p>
      </div>
      <div className="mt-5">
        <StageStepper generation={g} now={now} />
      </div>
    </Card>
  );
}

function ErrorPanel({ generation: g }: { generation: GenerationDTO }) {
  if (!g.error) return null;
  return (
    <section role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft px-4 py-4 sm:px-5">
      <div className="flex gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5 text-sm">
          <h2 className="font-semibold">{g.status === 'failed' ? 'Generation failed' : 'A problem was reported'}</h2>
          <p className="break-words">{g.error.message}</p>
          <p className="font-mono text-xs text-muted">Code: {g.error.code}</p>
          <p className="text-muted">
            {g.error.retryable
              ? 'This looks like a temporary problem. Regenerating usually works.'
              : 'Regenerating with the same inputs is likely to fail again. Use Edit and regenerate to change the script, settings or split.'}
          </p>
        </div>
      </div>
    </section>
  );
}

function CostPanel({ generation: g }: { generation: GenerationDTO }) {
  const actual = g.actualCost;
  const estimated = g.estimatedCost;
  const delta = actual ? actual.totalUsd - estimated.totalUsd : null;
  return (
    <Card title="Cost">
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface-2 px-3 py-2.5">
          <dt className="text-xs text-muted">Estimated</dt>
          <dd className="text-lg font-semibold tabular-nums">{formatUsd(estimated.totalUsd)}</dd>
        </div>
        <div className="rounded-xl bg-surface-2 px-3 py-2.5">
          <dt className="text-xs text-muted">Actual</dt>
          <dd className="text-lg font-semibold tabular-nums">{actual ? formatUsd(actual.totalUsd) : '-'}</dd>
          {delta !== null && Math.abs(delta) >= 0.0001 && (
            <dd className="text-xs text-muted tabular-nums">
              {delta > 0 ? '+' : '-'}
              {formatUsd(Math.abs(delta))} vs estimate
            </dd>
          )}
        </div>
      </dl>
      <div className="mt-4 space-y-4">
        {actual ? (
          <>
            <Collapsible summary="Actual cost breakdown" defaultOpen>
              <CostBreakdownView breakdown={actual} />
            </Collapsible>
            <Collapsible summary="Estimate made before generation">
              <CostBreakdownView breakdown={estimated} />
            </Collapsible>
          </>
        ) : (
          <>
            <Collapsible summary="Estimate breakdown" defaultOpen>
              <CostBreakdownView breakdown={estimated} />
            </Collapsible>
            <p className="text-xs text-muted">
              The actual cost is calculated from the token usage Google reports for each turn and appears here when
              available.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

const ASSEMBLY_LABELS: Record<NonNullable<GenerationDTO['assembly']>, string> = {
  model_full: 'Single 20s file returned by the model',
  concatenated: 'Part 1 and part 2 joined with ffmpeg',
};

function OutputPanel({ generation: g, model }: { generation: GenerationDTO; model: string | null }) {
  const s = g.settings;
  const rows: Array<[string, string]> = [
    ['Duration', formatVideoLength(g.durationSec)],
    ['Assembly', g.assembly ? ASSEMBLY_LABELS[g.assembly] : isTerminalStatus(g.status) ? '-' : 'Pending'],
    ['Resolution', `${RESOLUTION_LABELS[s.resolution]}, 9:16`],
    ['Style', STYLE_LABELS[s.style]],
    ['Image mode', IMAGE_MODE_LABELS[s.imageMode]],
    ['Language', `${languageLabel(s.language)} (${s.language})`],
    ['Reinforce character in part 2', s.reinforceCharacterOnExtend ? 'Yes' : 'No'],
  ];
  if (s.voiceHint) rows.push(['Voice direction', s.voiceHint]);
  if (s.extraDirections) rows.push(['Extra directions', s.extraDirections]);
  if (model) rows.push(['Model', model]);
  if (g.startedAt) rows.push(['Started', formatDateTime(g.startedAt)]);
  if (g.completedAt) rows.push(['Finished', formatDateTime(g.completedAt)]);

  return (
    <Card title="Output and settings">
      <dl className="divide-y divide-line text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 py-2 first:pt-0 last:pb-0">
            <dt className="w-2/5 shrink-0 text-muted">{label}</dt>
            <dd className="min-w-0 flex-1 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function GenerationSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading video">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-4 w-60" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <Skeleton className="mx-auto aspect-[9/16] w-full max-w-[320px] rounded-[2rem]" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
