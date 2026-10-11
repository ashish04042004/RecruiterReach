import { NavLink, Route, Routes } from 'react-router-dom';
import {
  BarChart3, ClipboardCheck, FileSpreadsheet, FileText, History, LayoutDashboard, Megaphone, Reply, Send, Settings, Users,
} from 'lucide-react';
import { cx } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Imports from './pages/Imports.jsx';
import ImportReview from './pages/ImportReview.jsx';
import Contacts from './pages/Contacts.jsx';
import Resumes from './pages/Resumes.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Review from './pages/Review.jsx';
import Sending from './pages/Sending.jsx';
import FollowUps from './pages/FollowUps.jsx';
import Analytics from './pages/Analytics.jsx';
import Activity from './pages/Activity.jsx';
import SettingsPage from './pages/Settings.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/imports', label: 'Import', icon: FileSpreadsheet },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/resumes', label: 'Resumes', icon: FileText },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/review', label: 'Review queue', icon: ClipboardCheck },
  { to: '/sending', label: 'Sending', icon: Send },
  { to: '/follow-ups', label: 'Replies & follow-ups', icon: Reply },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/activity', label: 'Audit trail', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-5 py-4">
          <p className="text-lg font-bold text-indigo-700">RecruiterReach</p>
          <p className="text-xs text-slate-500">Local outreach manager</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm',
                  isActive ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-100',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="px-5 py-3 text-xs text-slate-400">Nothing is sent without your approval.</p>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/imports/:id" element={<ImportReview />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/resumes" element={<Resumes />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/review" element={<Review />} />
          <Route path="/sending" element={<Sending />} />
          <Route path="/sending/:id" element={<Sending />} />
          <Route path="/follow-ups" element={<FollowUps />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
