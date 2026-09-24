import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Captions, Download, RefreshCw, Scissors, SquarePen, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { isTerminalStatus, type GenerationDTO, type RegenerateRequest } from '@shared/api';
import { addCaptions, cancelGeneration, deleteGeneration, regenerateGeneration } from '../lib/api';
import { preventImplicitSubmit } from '../lib/forms';
import { invalidateAfterGenerationChange, queryKeys } from '../lib/hooks';
import { diffSegmentEdits, SEGMENT_FIELDS, type SegmentEdits } from '../lib/plan';
import { cn } from '../lib/cn';
import { Button, buttonClass } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { CostEstimate } from './CostEstimateCard';
import { Dialog } from './Dialog';
import { ErrorAlert } from './ErrorAlert';
import { inputClass } from './Field';
import { useToast } from './Toast';

type OpenDialog = null | 'full' | 'part2' | 'cancel' | 'delete';

/** Download, regenerate (full or part 2), edit and regenerate, cancel and delete. */
export function GenerationActions({ generation: g }: { generation: GenerationDTO }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const terminal = isTerminalStatus(g.status);
  const part2Unavailable = !terminal
    ? 'Available when this generation has finished'
    : !g.canRegeneratePart2
      ? g.part1VideoUrl
        ? 'Part 1 of this video can no longer be extended. Use Regenerate instead.'
        : 'Needs a finished part 1 (0-10s)'
      : undefined;

  const openNewGeneration = (dto: GenerationDTO, title: string) => {
    queryClient.setQueryData(queryKeys.generation(dto.id), dto);
    invalidateAfterGenerationChange(queryClient);
    setDialog(null);
    toast.push({ tone: 'success', title, description: 'Opening the new generation.' });
    void navigate(`/generations/${dto.id}`);
  };

  const regenerateFull = useMutation({
    mutationFn: () => regenerateGeneration(g.id, { mode: 'full' }),
    onSuccess: (dto) => openNewGeneration(dto, 'Regeneration queued'),
  });

  const regeneratePart2 = useMutation({
    mutationFn: (part2: RegenerateRequest['part2']) =>
      regenerateGeneration(g.id, part2 && Object.keys(part2).length > 0 ? { mode: 'part2', part2 } : { mode: 'part2' }),
    onSuccess: (dto) => openNewGeneration(dto, 'Part 2 regeneration queued'),
  });

  const captions = useMutation({
    mutationFn: () => addCaptions(g.id),
    onSuccess: (dto) => {
      queryClient.setQueryData(queryKeys.generation(dto.id), dto);
      invalidateAfterGenerationChange(queryClient);
      toast.push({ tone: 'success', title: dto.hasCaptions ? 'Captions added' : 'Done' });
    },
    onError: (err) =>
      toast.push({
        tone: 'error',
        title: 'Could not add captions',
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const cancel = useMutation({
    mutationFn: () => cancelGeneration(g.id),
    onSuccess: (dto) => {
      queryClient.setQueryData(queryKeys.generation(dto.id), dto);
      invalidateAfterGenerationChange(queryClient);
      setDialog(null);
      toast.push(
        dto.status === 'canceled'
          ? { tone: 'info', title: 'Generation canceled' }
          : { tone: 'info', title: 'Cancel requested', description: 'The job stops at the next checkpoint.' },
      );
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteGeneration(g.id),
    onSuccess: () => {
      setDialog(null);
      toast.push({ tone: 'success', title: 'Video deleted' });
      void navigate('/history', { replace: true });
      queryClient.removeQueries({ queryKey: queryKeys.generation(g.id) });
      invalidateAfterGenerationChange(queryClient);
    },
  });

  const close = () => {
    setDialog(null);
    regenerateFull.reset();
    regeneratePart2.reset();
    cancel.reset();
    remove.reset();
  };

  return (
    <div className="space-y-3">
      {g.downloadUrl ? (
        <a href={g.downloadUrl} download className={buttonClass('primary', 'lg', 'w-full')}>
          <Download className="size-5" aria-hidden="true" />
          Download MP4
        </a>
      ) : (
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled
          title="Available when the video is ready"
          icon={<Download className="size-5" aria-hidden="true" />}
        >
          Download MP4
        </Button>
      )}
      {g.cleanDownloadUrl && (
        <a
          href={g.cleanDownloadUrl}
          download
          className="block text-center text-sm font-medium text-accent-text underline-offset-2 hover:underline"
        >
          Download without captions
        </a>
      )}

      <div className="grid gap-2">
        <Button
          onClick={() => setDialog('full')}
          disabled={!terminal}
          title={terminal ? undefined : 'Available when this generation has finished'}
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          Regenerate
        </Button>
        {g.canAddCaptions && (
          <Button
            onClick={() => captions.mutate()}
            loading={captions.isPending}
            disabled={captions.isPending}
            icon={<Captions className="size-4" aria-hidden="true" />}
          >
            {g.hasCaptions ? 'Redo captions' : 'Add captions'}
          </Button>
        )}
        <Button
          onClick={() => setDialog('part2')}
          disabled={part2Unavailable !== undefined}
          title={part2Unavailable}
          icon={<Scissors className="size-4" aria-hidden="true" />}
        >
          Regenerate part 2 only
        </Button>
        <Link to={`/?from=${encodeURIComponent(g.id)}`} className={buttonClass('secondary', 'md')}>
          <SquarePen className="size-4" aria-hidden="true" />
          Edit and regenerate
        </Link>
        {g.canCancel && (
          <Button
            variant="danger-soft"
            onClick={() => setDialog('cancel')}
            icon={<Ban className="size-4" aria-hidden="true" />}
          >
            Cancel generation
          </Button>
        )}
        {terminal && (
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            onClick={() => setDialog('delete')}
            icon={<Trash2 className="size-4" aria-hidden="true" />}
          >
            Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={dialog === 'full'}
        onClose={close}
        onConfirm={() => regenerateFull.mutate()}
        pending={regenerateFull.isPending}
        error={regenerateFull.error}
        title="Regenerate this video?"
        description="Creates a new 20-second video with the same script, settings, split and character image. This video stays in your history."
        confirmLabel="Regenerate"
        confirmIcon={<RefreshCw className="size-4" aria-hidden="true" />}
        size="md"
      >
        <CostEstimate
          resolution={g.settings.resolution}
          mode="full"
          reinforceCharacterOnExtend={g.settings.reinforceCharacterOnExtend}
          hasPlan={g.plan !== null}
        />
      </ConfirmDialog>

      <Dialog
        open={dialog === 'part2'}
        onClose={close}
        dismissible={!regeneratePart2.isPending}
        title="Regenerate part 2 only"
        description="Keeps part 1 (0-10s) and runs the 10-second extension again from the same interaction. Edit the part 2 directions or leave them as they are."
        size="lg"
      >
        <Part2Form
          generation={g}
          pending={regeneratePart2.isPending}
          error={regeneratePart2.error}
          onCancel={close}
          onSubmit={(part2) => regeneratePart2.mutate(part2)}
        />
      </Dialog>

      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={close}
        onConfirm={() => cancel.mutate()}
        pending={cancel.isPending}
        error={cancel.error}
        title="Cancel this generation?"
        description="Queued jobs stop immediately. Running jobs stop at the next checkpoint. Charges for turns that already ran still apply."
        confirmLabel="Cancel generation"
        cancelLabel="Keep generating"
        confirmVariant="danger"
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={close}
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error}
        title="Delete this video?"
        description="The video, its parts and thumbnail are deleted. This cannot be undone. Cost records are kept for budgeting."
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmIcon={<Trash2 className="size-4" aria-hidden="true" />}
      />
    </div>
  );
}

function Part2Form({
  generation: g,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  generation: GenerationDTO;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (part2: RegenerateRequest['part2']) => void;
}) {
  const id = useId();
  const original = g.plan?.segments[1] ?? null;
  const [edits, setEdits] = useState<SegmentEdits>(() => ({
    dialogue: original?.dialogue ?? '',
    action: original?.action ?? '',
    camera: original?.camera ?? '',
    onScreenText: original?.onScreenText ?? '',
  }));
  const changes = diffSegmentEdits(original, edits);
  const changedCount = Object.keys(changes).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    onSubmit(changedCount > 0 ? changes : undefined);
  };

  return (
    <form onSubmit={submit} onKeyDown={preventImplicitSubmit} className="space-y-4">
      {SEGMENT_FIELDS.map(({ field, label, multiline }) => (
        <div key={field} className="space-y-1">
          <label htmlFor={`${id}-${field}`} className="text-sm font-medium">
            {label}
          </label>
          {multiline ? (
            <textarea
              id={`${id}-${field}`}
              value={edits[field]}
              rows={3}
              onChange={(event) => setEdits((current) => ({ ...current, [field]: event.target.value }))}
              className={cn(inputClass, 'resize-y')}
            />
          ) : (
            <input
              id={`${id}-${field}`}
              value={edits[field]}
              onChange={(event) => setEdits((current) => ({ ...current, [field]: event.target.value }))}
              className={inputClass}
            />
          )}
        </div>
      ))}
      <p className="text-xs text-muted">
        {changedCount === 0
          ? 'No changes: part 2 is generated again with the original directions.'
          : `${changedCount} ${changedCount === 1 ? 'field' : 'fields'} changed.`}
      </p>
      <div className="rounded-xl border border-line p-3">
        <p className="mb-2 text-sm font-medium">Estimated cost (part 2 only)</p>
        <CostEstimate
          resolution={g.settings.resolution}
          mode="part2"
          reinforceCharacterOnExtend={g.settings.reinforceCharacterOnExtend}
        />
      </div>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          icon={<Scissors className="size-4" aria-hidden="true" />}
        >
          Regenerate part 2
        </Button>
      </div>
    </form>
  );
}
