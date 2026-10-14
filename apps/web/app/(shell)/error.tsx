'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="loading" role="alert">
      <p>The control centre could not load this view.</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
