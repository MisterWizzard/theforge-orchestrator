import { PrimaryNav } from '../../components/primary-nav';

/**
 * The signed-in shell: rail, navigation, sign-out and the content column.
 * Every page in this group sits behind the operator login (middleware.ts);
 * `/login` lives outside it and gets the bare document.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="/">
          <span className="brandmark">F</span>
          <span>TheForge</span>
        </a>
        <PrimaryNav />
        <a className="signOut" href="/logout">
          Log out
        </a>
        <div className="railFoot">
          <span className="pulse" />
          Coordinator online
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
