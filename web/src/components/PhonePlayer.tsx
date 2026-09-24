import { Ban, CircleX, RefreshCw, Sparkles, VideoOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { STAGE_LABELS, isTerminalStatus, type GenerationDTO } from '@shared/api';
import { cn } from '../lib/cn';

type PlayerSource = Pick<
  GenerationDTO,
  'status' | 'stage' | 'videoUrl' | 'part1VideoUrl' | 'thumbnailUrl' | 'characterImageUrl' | 'title'
>;

function PhoneFrame({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <figure className="mx-auto w-full max-w-[280px] sm:max-w-[320px]">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[2rem] border-[6px] border-frame bg-black shadow-xl">
        {children}
      </div>
      {label && <figcaption className="mt-2 text-center text-xs font-medium text-muted">{label}</figcaption>}
    </figure>
  );
}

/** Whether this browser can decode Omni's output format (H.264 video with AAC audio in MP4). */
function canPlayH264(): boolean {
  if (typeof document === 'undefined') return true;
  return document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') !== '';
}

/** <video> that shows a message instead of a blank frame when the file cannot be loaded. */
function PlayerVideo({ src, poster, label }: { src: string; poster?: string; label: string }) {
  const [failed, setFailed] = useState<'network' | 'unsupported' | null>(null);
  if (failed) {
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white"
      >
        <VideoOff className="size-6" aria-hidden="true" />
        <p>
          {failed === 'unsupported'
            ? 'This browser cannot play H.264 video. Download the MP4 to watch it, or open this page in Chrome, Safari, Edge or Firefox.'
            : 'The video could not be loaded. Check your connection, then try again.'}
        </p>
        <button
          type="button"
          onClick={() => setFailed(null)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/40 px-3 py-1.5 font-medium hover:bg-white/10"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
  return (
    <video
      src={src}
      poster={poster}
      controls
      playsInline
      preload="metadata"
      onError={(event) => {
        const code = event.currentTarget.error?.code;
        // MEDIA_ERR_SRC_NOT_SUPPORTED (4) is also reported for HTTP failures, so check the codec itself.
        setFailed(code === 4 && !canPlayH264() ? 'unsupported' : 'network');
      }}
      data-testid="phone-player-video"
      className="size-full bg-black object-contain"
      aria-label={label}
    />
  );
}

/**
 * 9:16 player. Shows the final video when ready, part 1 while the extension is running,
 * and the character image with a progress overlay before that.
 */
export function PhonePlayer({ generation: g }: { generation: PlayerSource }) {
  if (g.videoUrl) {
    return (
      <PhoneFrame>
        <PlayerVideo
          key={g.videoUrl}
          src={g.videoUrl}
          poster={g.thumbnailUrl ?? undefined}
          label={`${g.title}, final 20-second video`}
        />
      </PhoneFrame>
    );
  }

  if (g.part1VideoUrl) {
    return (
      <PhoneFrame label="Part 1 preview (0-10s)">
        <PlayerVideo
          key={g.part1VideoUrl}
          src={g.part1VideoUrl}
          label={`${g.title}, part 1 preview, first 10 seconds`}
        />
      </PhoneFrame>
    );
  }

  const active = !isTerminalStatus(g.status);
  return (
    <PhoneFrame>
      <img
        src={g.characterImageUrl}
        alt="Character image"
        className={cn('size-full object-cover', active ? 'opacity-70' : 'opacity-40 grayscale')}
      />
      {active ? (
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-linear-to-b from-black/10 via-transparent to-black/60" />
          <div className="absolute inset-x-0 h-1/2 bg-linear-to-b from-transparent via-white/15 to-transparent motion-safe:animate-shimmer" />
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-4 text-sm font-medium text-white">
            <Sparkles className="size-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
            <span>{STAGE_LABELS[g.stage]}</span>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 p-6 text-center text-sm font-medium text-white">
          {g.status === 'canceled' ? (
            <Ban className="size-6" aria-hidden="true" />
          ) : (
            <CircleX className="size-6" aria-hidden="true" />
          )}
          {g.status === 'canceled' ? 'Generation canceled' : 'No video was produced'}
        </div>
      )}
    </PhoneFrame>
  );
}
