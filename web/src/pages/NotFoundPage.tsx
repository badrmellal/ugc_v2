import { FileQuestion } from 'lucide-react';
import { Link } from 'react-router';
import { useDocumentTitle } from '../lib/hooks';
import { buttonClass } from '../components/Button';

export function NotFoundState({
  title = 'Page not found',
  message = 'The page you are looking for does not exist or was moved.',
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <FileQuestion className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link to="/" className={buttonClass('primary')}>
          Create a video
        </Link>
        <Link to="/history" className={buttonClass('secondary')}>
          Open history
        </Link>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  useDocumentTitle('Not found');
  return <NotFoundState />;
}
