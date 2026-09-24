import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { isApiError, onUnauthorized } from './lib/api';
import { queryKeys, useSession } from './lib/hooks';
import { ErrorState } from './components/ErrorAlert';
import { Layout } from './components/Layout';
import { FullPageSpinner } from './components/Spinner';
import { ToastProvider } from './components/Toast';
import { CreatePage } from './pages/CreatePage';
import { GenerationPage } from './pages/GenerationPage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';

/** Retries network and 5xx failures twice; never retries 4xx (validation, auth, not found...). */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 5_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <CreatePage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'generations/:id', element: <GenerationPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

/** Shows the login screen when the server requires auth and there is no valid session. */
function AuthGate() {
  const session = useSession();

  if (session.isPending) return <FullPageSpinner label="Loading" />;
  if (session.isError && !session.data) {
    return (
      <div className="flex min-h-dvh items-center">
        <ErrorState
          title="Could not reach the server"
          error={session.error}
          onRetry={() => void session.refetch()}
          retrying={session.isFetching}
        />
      </div>
    );
  }
  if (session.data.authRequired && !session.data.authenticated) return <LoginPage />;
  return <RouterProvider router={router} />;
}

export function App({ queryClient }: { queryClient: QueryClient }) {
  // Any 401 means the session expired or was revoked: re-check it so the login screen appears.
  useEffect(
    () =>
      onUnauthorized(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.session });
      }),
    [queryClient],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthGate />
      </ToastProvider>
    </QueryClientProvider>
  );
}
