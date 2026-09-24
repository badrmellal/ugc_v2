import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { CircleAlert } from 'lucide-react';
import { Button, buttonClass } from '../components/Button';
import { NotFoundState } from './NotFoundPage';

/** Shown when a route throws while rendering. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="min-h-dvh">
        <NotFoundState />
      </div>
    );
  }
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <CircleAlert className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="mt-1 text-sm break-words text-muted">{message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
        <Link to="/" className={buttonClass('secondary')} reloadDocument>
          Go to Create
        </Link>
      </div>
    </div>
  );
}
