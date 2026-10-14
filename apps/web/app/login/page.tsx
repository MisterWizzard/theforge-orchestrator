import type { Metadata } from 'next';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_VARIABLE,
  SECRET_VARIABLE,
  readOperatorAuth,
} from '../../lib/auth/config';
import { safeNextPath } from '../../lib/auth/gate';

// The page reads the environment per request: prerendering it at build time
// would bake in whatever the build machine had, which is never the password.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in — TheForge',
};

const messages: Record<string, string> = {
  invalid: 'That password is not right.',
  locked: 'Too many attempts. Wait a minute, then try again.',
  unconfigured: 'Operator login is not configured.',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const auth = readOperatorAuth(process.env);
  const next = safeNextPath(first(params.next));
  const error = first(params.error);
  const message = error ? (messages[error] ?? 'Sign-in failed. Try again.') : '';
  return (
    <main className="auth">
      <div className="authCard">
        <span className="brand">
          <span className="brandmark">F</span>
          <span>TheForge</span>
        </span>
        {auth.configured ? (
          <form method="post" action="/login/session" className="authForm">
            <h1>Operator sign-in</h1>
            <p>The control centre is private. Enter the operator password to continue.</p>
            {message ? (
              <p className="authError" role="alert">
                {message}
              </p>
            ) : null}
            <label htmlFor="password">Operator password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
            {next !== '/' ? <input type="hidden" name="next" value={next} /> : null}
            <button type="submit">Sign in</button>
          </form>
        ) : (
          <div className="authForm" role="alert">
            <h1>Operator login is not configured</h1>
            <p>{auth.reason}. The control centre answers nothing until it is.</p>
            <p>
              Set <code>{PASSWORD_VARIABLE}</code> ({MIN_PASSWORD_LENGTH} or more characters) in{' '}
              <code>.env</code> and restart the web app. <code>{SECRET_VARIABLE}</code> is optional.
              See <code>docs/OPERATIONS.md</code>, &ldquo;Operator login&rdquo;.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
