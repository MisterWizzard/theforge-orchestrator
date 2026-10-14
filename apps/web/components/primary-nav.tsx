'use client';

import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Runs' },
  { href: '/#workers', label: 'Workers' },
  { href: '/#approvals', label: 'Approvals' },
  { href: '/#providers', label: 'Providers' },
  { href: '/settings', label: 'Settings' },
] as const;

export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary">
      {links.map((link) => {
        const current = link.href === '/settings' ? pathname === '/settings' : link.href === '/';
        return (
          <a
            className={current ? 'active' : undefined}
            href={link.href}
            aria-current={current ? 'page' : undefined}
            key={link.href}
          >
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
