// Rendered in the bare root layout (the shell lives in `(shell)/`), so it
// carries its own centred card.
export default function NotFound() {
  return (
    <main className="auth">
      <div className="authCard">
        <div className="authForm">
          <h1>Run not found</h1>
          <p>
            <a href="/">Return to build runs</a>
          </p>
        </div>
      </div>
    </main>
  );
}
