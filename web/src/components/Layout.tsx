import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, FlaskConical, GalleryVerticalEnd, LogOut, Plus, Wallet } from 'lucide-react';
import { NavLink, Outlet, ScrollRestoration } from 'react-router';
import type { AppConfigResponse, SessionResponse } from '@shared/api';
import { logout } from '../lib/api';
import { formatUsd } from '../lib/format';
import { queryKeys, useAppConfig, useSession } from '../lib/hooks';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { useToast } from './Toast';

function BudgetPill({ budget }: { budget: AppConfigResponse['budget'] }) {
  if (budget.dailyLimitUsd === null) return null;
  const used = budget.spentTodayUsd + budget.reservedUsd;
  const ratio = budget.dailyLimitUsd > 0 ? used / budget.dailyLimitUsd : 1;
  const tone =
    ratio >= 1 ? 'text-danger bg-danger-soft' : ratio >= 0.8 ? 'text-warn bg-warn-soft' : 'text-muted bg-surface-2';
  const detail = `Daily budget (UTC): ${formatUsd(budget.spentTodayUsd)} spent, ${formatUsd(
    budget.reservedUsd,
  )} reserved for running jobs, ${formatUsd(budget.dailyLimitUsd)} limit.`;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums', tone)}
      title={detail}
    >
      <Wallet className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{detail}</span>
      <span aria-hidden="true" className="sm:hidden">
        {Math.round(ratio * 100)}%
      </span>
      <span aria-hidden="true" className="hidden sm:inline">
        {formatUsd(used)} / {formatUsd(budget.dailyLimitUsd)} today
      </span>
    </span>
  );
}

function MockBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2.5 py-1 text-xs font-medium text-info"
      title="Mock mode: videos are synthetic test clips and Google is not called."
    >
      <FlaskConical className="size-3.5" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">Mock mode</span>
    </span>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors sm:px-3',
    isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
  );

function SignOutButton({ session }: { session: SessionResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
      queryClient.setQueryData<SessionResponse>(queryKeys.session, {
        authenticated: false,
        authRequired: true,
        user: null,
      });
    },
    onError: () => toast.push({ tone: 'error', title: 'Sign out failed', description: 'Try again.' }),
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => mutation.mutate()}
      loading={mutation.isPending}
      title={session.user ? `Signed in as ${session.user}` : undefined}
      icon={<LogOut className="size-4" aria-hidden="true" />}
    >
      <span className="sr-only sm:not-sr-only">Sign out</span>
    </Button>
  );
}

export function Layout() {
  const config = useAppConfig();
  const session = useSession();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/70">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Clapperboard className="size-4" aria-hidden="true" />
            </span>
            <span className="hidden sm:inline">Omni UGC Studio</span>
            <span className="sr-only sm:hidden">Omni UGC Studio</span>
          </NavLink>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink to="/" end className={navClass}>
              <Plus className="size-4" aria-hidden="true" />
              Create
            </NavLink>
            <NavLink to="/history" className={navClass}>
              <GalleryVerticalEnd className="size-4" aria-hidden="true" />
              History
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {config.data?.mock && <MockBadge />}
            {config.data && <BudgetPill budget={config.data.budget} />}
            {session.data?.authRequired && <SignOutButton session={session.data} />}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-subtle sm:px-6">
          <span>Omni UGC Studio</span>
          {config.data && (
            <span>
              Video model: <span className="font-mono">{config.data.models.video}</span>
            </span>
          )}
        </div>
      </footer>
      <ScrollRestoration />
    </div>
  );
}
