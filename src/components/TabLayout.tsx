import { NavLink, Outlet } from 'react-router-dom';

interface TabDef {
  to: string;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { to: '/', label: 'ホーム', icon: '☀️' },
  { to: '/scenarios', label: 'シナリオ', icon: '🗺️' },
  { to: '/reports', label: 'レポート', icon: '📝' },
  { to: '/progress', label: '進捗', icon: '📈' },
  { to: '/settings', label: '設定', icon: '⚙️' },
];

export function TabLayout() {
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md border-t border-neutral-200 bg-white">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
                isActive ? 'text-hana-600' : 'text-neutral-400'
              }`
            }
          >
            <span className="text-lg leading-none">{tab.icon}</span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
