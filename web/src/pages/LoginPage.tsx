import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, LogIn } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { SessionResponse } from '@shared/api';
import { isApiError, login } from '../lib/api';
import { describeError } from '../lib/errors';
import { queryKeys, useDocumentTitle } from '../lib/hooks';
import { Button } from '../components/Button';
import { inputClass } from '../components/Field';

function loginErrorMessage(error: unknown): string {
  if (isApiError(error) && error.status === 401) return 'Incorrect password. Try again.';
  if (isApiError(error) && error.status === 429) return 'Too many attempts. Wait a minute, then try again.';
  return describeError(error).message;
}

export function LoginPage() {
  useDocumentTitle('Sign in');
  const id = useId();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: (session) => {
      queryClient.setQueryData<SessionResponse>(queryKeys.session, session);
      // Anything fetched while signed out is stale now.
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || mutation.isPending) return;
    mutation.mutate(password);
  };

  const error = mutation.isError ? loginErrorMessage(mutation.error) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-sm">
            <Clapperboard className="size-5" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Omni UGC Studio</h1>
          <p className="mt-1 text-sm text-muted">Sign in to create and manage videos.</p>
        </div>
        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-sm"
          noValidate
        >
          <div className="space-y-1.5">
            <label htmlFor={`${id}-password`} className="text-sm font-medium">
              Password
            </label>
            <input
              id={`${id}-password`}
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              className={inputClass}
            />
            {error && (
              <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger">
                {error}
              </p>
            )}
          </div>
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={mutation.isPending}
            disabled={!password}
            icon={<LogIn className="size-4" aria-hidden="true" />}
          >
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
